// content.json 자동 갱신 스크립트 (GitHub Actions에서 매일 실행)
// - 시세(코스피·환율)는 공개 구글시트에서 가져와 시장 브리핑/지표/추천·주의 종목을 무료 Gemini로 갱신
// - 종목 선정은 6자리 코드·필수항목 검증 통과 시에만 반영, 실패 시 기존값 유지(안전판)
// - GEMINI_API_KEY(무료) 환경변수 필요. 실패하면 기존 파일 유지(갱신 스킵).
// Node 18+ (전역 fetch)

const fs = require("fs");

// 공개 구글시트(지수·환율) gviz CSV — 본인 시트 ID로 교체 가능
const MACRO_CSV = "https://docs.google.com/spreadsheets/d/1eeEwRXUiExYa-wt6IFq3dyvcvqHhvJxls84dLp-XuIw/gviz/tq?tqx=out:csv";
const MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-2.0-flash"];
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
  let lastErr = "응답 없음";
  for (const model of MODELS) {
    try {
      const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + KEY;
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, responseMimeType: "application/json" },
        }),
      });
      const d = await r.json();
      if (d.error) { lastErr = model + ": " + (d.error.message || JSON.stringify(d.error)); continue; }
      const txt = d && d.candidates && d.candidates[0] && d.candidates[0].content
        && d.candidates[0].content.parts && d.candidates[0].content.parts[0].text;
      if (!txt) { lastErr = model + ": 빈 응답"; continue; }
      console.log("사용 모델:", model);
      return JSON.parse(txt);
    } catch (e) { lastErr = model + ": " + e.message; }
  }
  throw new Error(lastErr);
}

(async () => {
  if (!KEY) { console.log("GEMINI_API_KEY 없음 — 스킵"); return; }
  let base = {};
  try { base = JSON.parse(fs.readFileSync("content.json", "utf8")); } catch (e) {}

  const macro = await getMacro();
  const ctx = "오늘(" + todayKST() + ") 한국 증시. 코스피=" + (macro.KOSPI ? macro.KOSPI.price + "(" + macro.KOSPI.rate + "%)" : "?")
    + ", 원/달러=" + (macro.USDKRW ? macro.USDKRW.price : "?") + ".";

  const prompt = ctx + "\n당신은 한국 주식 애널리스트입니다. 위 데이터와 최신 시장 상황을 바탕으로 한국 증시 분석을 아래 JSON 형식으로만 출력하세요. 사실·정보 정리 위주, 과장·확정적 매매권유 금지.\n"
    + "stocks는 코스피 위주 실제 6자리 종목코드와 정확한 한글 종목명으로, 관심(g:\"buy\", light:\"g\") 10개 + 주의(g:\"avoid\", light:\"r\" 또는 \"y\") 10개 총 20개. 섹터를 분산(반도체에만 몰지 말 것). score는 0~100(높을수록 긍정), conf는 상/중/하, ai는 \"4/4\" 또는 \"3/4\", pts는 2개, url은 실제 기사/리포트.\n"
    + '{"brief":[{"t":"현황","c":"t-pos","x":"..."},{"t":"동인","c":"t-pos","x":"..."},{"t":"주의","c":"t-neg","x":"..."}],'
    + '"scenarios":[{"pl":"상승 시나리오","h":"강세","p":"p-bull","d":"..."},{"pl":"중립 시나리오","h":"기본","p":"p-base","d":"..."},{"pl":"조정 시나리오","h":"약세","p":"p-bear","d":"..."}],'
    + '"consensusTxt":"<b>합의:</b> ... <b>이견:</b> ...",'
    + '"monitor":[{"k":"코스피 지수","v":"..."},{"k":"원/달러","v":"..."},{"k":"외국인 수급","v":"..."},{"k":"미 10년물","v":"..."},{"k":"VIX","v":"..."},{"k":"반도체 수출","v":"..."}],'
    + '"stocks":[{"g":"buy","code":"005930","name":"삼성전자","sector":"반도체",'
    + '"light":"g","score":62,"tone":"중립~낙관","conf":"상","ai":"4/4",'
    + '"sum":"...","pts":["...","..."],"risk":"...","out":"...","src":"출처명","url":"https://..."}]}';

  let gen;
  try { gen = await gemini(prompt); }
  catch (e) { console.log("Gemini 실패 — 기존 유지:", e.message); return; }

  // 종목 선정 검증: 6자리 코드·필수항목 정상이고 10개 이상일 때만 반영, 아니면 기존값 유지
  function validStocks(arr){
    if(!Array.isArray(arr)) return null;
    const ok = arr.filter(s => s && /^[0-9]{6}$/.test(String(s.code||"")) && s.name
      && (s.g==="buy"||s.g==="avoid") && ["g","y","r"].includes(s.light));
    ok.forEach(s => { s.code=String(s.code); if(!Array.isArray(s.pts)) s.pts=[]; if(!s.ai) s.ai=(s.conf==="상"?"4/4":"3/4"); });
    return ok.length>=10 ? ok : null;
  }

  const out = Object.assign({}, base, {
    updated: todayKST() + " (자동)",
    brief: gen.brief || base.brief,
    scenarios: gen.scenarios || base.scenarios,
    consensusTxt: gen.consensusTxt || base.consensusTxt,
    monitor: gen.monitor || base.monitor,
    stocks: validStocks(gen.stocks) || base.stocks,
  });
  fs.writeFileSync("content.json", JSON.stringify(out, null, 1));
  console.log("content.json 갱신 완료:", out.updated);
})();
