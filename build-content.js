// content.json 자동 갱신 스크립트 (GitHub Actions에서 매일 실행)
// - 시세(코스피·환율)는 공개 구글시트에서 가져와 시장 브리핑/지표를 무료 Gemini로 갱신
// - 추천/주의 '종목 선정'은 기존 content.json을 그대로 보존(안전). 시장 코멘트만 매일 갱신.
// - GEMINI_API_KEY(무료) 환경변수 필요. 실패하면 기존 파일 유지(갱신 스킵).
// Node 18+ (전역 fetch)

const fs = require("fs");

// 공개 구글시트(지수·환율) gviz CSV — 본인 시트 ID로 교체 가능
const MACRO_CSV = "https://docs.google.com/spreadsheets/d/1eeEwRXUiExYa-wt6IFq3dyvcvqHhvJxls84dLp-XuIw/gviz/tq?tqx=out:csv";
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const KEY = process.env.GEMINI_API_KEY || "";

function todayKST() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

async function getMacro() {
  try {
    const r = await fetch(MACRO_CSV);
    const t = await r.text();
    const m = {};
    t.split(/\r?\n/).forEach((line) => {
      const c = line.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
      if (/^[A-Z]+$/.test(c[0])) m[c[0]] = { price: c[1], rate: c[2] };
    });
    return m;
  } catch (e) { return {}; }
}

async function gemini(prompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent?key=" + KEY;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
    }),
  });
  const d = await r.json();
  const txt = d && d.candidates && d.candidates[0] && d.candidates[0].content
    && d.candidates[0].content.parts[0].text;
  return JSON.parse(txt);
}

(async () => {
  if (!KEY) { console.log("GEMINI_API_KEY 없음 — 스킵"); return; }
  let base = {};
  try { base = JSON.parse(fs.readFileSync("content.json", "utf8")); } catch (e) {}

  const macro = await getMacro();
  const ctx = "오늘(" + todayKST() + ") 한국 증시. 코스피=" + (macro.KOSPI ? macro.KOSPI.price + "(" + macro.KOSPI.rate + "%)" : "?")
    + ", 원/달러=" + (macro.USDKRW ? macro.USDKRW.price : "?") + ".";

  const prompt = ctx + "\n위 데이터를 바탕으로 한국 증시 요약을 아래 JSON 형식으로만 출력. 사실 위주, 과장·매매권유 금지.\n"
    + '{"brief":[{"t":"현황","c":"t-pos","x":"..."},{"t":"동인","c":"t-pos","x":"..."},{"t":"주의","c":"t-neg","x":"..."}],'
    + '"scenarios":[{"pl":"상승 시나리오","h":"강세","p":"p-bull","d":"..."},{"pl":"중립 시나리오","h":"기본","p":"p-base","d":"..."},{"pl":"조정 시나리오","h":"약세","p":"p-bear","d":"..."}],'
    + '"consensusTxt":"<b>합의:</b> ... <b>이견:</b> ...",'
    + '"monitor":[{"k":"코스피 지수","v":"..."},{"k":"원/달러","v":"..."},{"k":"외국인 수급","v":"..."},{"k":"미 10년물","v":"..."},{"k":"VIX","v":"..."},{"k":"반도체 수출","v":"..."}]}';

  let gen;
  try { gen = await gemini(prompt); }
  catch (e) { console.log("Gemini 실패 — 기존 유지:", e.message); return; }

  // 종목 선정(stocks)·universe는 보존, 시장 코멘트만 교체
  const out = Object.assign({}, base, {
    updated: todayKST() + " (자동)",
    brief: gen.brief || base.brief,
    scenarios: gen.scenarios || base.scenarios,
    consensusTxt: gen.consensusTxt || base.consensusTxt,
    monitor: gen.monitor || base.monitor,
  });
  fs.writeFileSync("content.json", JSON.stringify(out, null, 1));
  console.log("content.json 갱신 완료:", out.updated);
})();
