// content.json 자동 갱신 스크립트 (GitHub Actions에서 평일 2회 실행)
// 2단계 파이프라인:
//   1) Gemini + Google Search 그라운딩으로 오늘의 실제 시장 사실을 수집 (수치·출처 포함)
//   2) 그 사실만을 근거로 대시보드 전체 스키마(JSON)를 생성
// 검증을 통과한 섹션만 반영하고, 실패한 섹션은 기존 값을 유지한다(안전판).
// 필요 환경변수: GEMINI_API_KEY
// Node 20+ (전역 fetch)

const fs = require("fs");

const QUOTE_CSV = "https://docs.google.com/spreadsheets/d/1pLFiMYoEJ9VHzYfucEVrfWcLKyj91DKi-My5rlaLAbc/gviz/tq?tqx=out:csv";
const MACRO_CSV = "https://docs.google.com/spreadsheets/d/1eeEwRXUiExYa-wt6IFq3dyvcvqHhvJxls84dLp-XuIw/gviz/tq?tqx=out:csv";
const KEY = process.env.GEMINI_API_KEY || "";
const MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"];
// SESSION=open(장 시작 전) | close(마감 후). 워크플로에서 주입.
const SESSION = (process.env.SESSION || "close").toLowerCase();

function todayKST() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

async function getCsv(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return "";
    return await r.text();
  } catch (e) { return ""; }
}

// 공개 시트에서 종목 시세를 뽑아 컨텍스트 문자열로 만든다.
function parseQuotes(csv) {
  const rows = [];
  csv.split(/\r?\n/).forEach((line) => {
    const c = line.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
    if (c.length >= 4 && /^[0-9]{1,6}$/.test(c[0]) && c[1] && c[1] !== "#N/A" && c[2]) {
      rows.push(`${c[0].padStart(6, "0")} ${c[1]} ${c[2]}(${c[3]}%)`);
    }
  });
  return rows;
}

function parseMacro(csv) {
  const out = [];
  csv.split(/\r?\n/).forEach((line) => {
    const c = line.split(",").map((x) => x.replace(/^"|"$/g, "").trim());
    if (/^[A-Z]{3,8}$/.test(c[0]) && c[1]) out.push(`${c[0]}=${c[1]}${c[2] ? `(${c[2]}%)` : ""}`);
  });
  return out;
}

// Gemini 호출. grounded=true 면 Google Search 도구를 붙이고 평문을, 아니면 JSON을 요구한다.
async function gemini(prompt, { grounded = false, maxTokens = 8192 } = {}) {
  let lastErr = "응답 없음";
  for (const model of MODELS) {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: grounded ? 0.2 : 0.45, maxOutputTokens: maxTokens },
    };
    if (grounded) body.tools = [{ google_search: {} }];
    else body.generationConfig.responseMimeType = "application/json";
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      );
      const d = await r.json();
      if (d.error) { lastErr = `${model}: ${d.error.message || JSON.stringify(d.error)}`; continue; }
      const parts = d?.candidates?.[0]?.content?.parts || [];
      const txt = parts.map((p) => p.text || "").join("").trim();
      if (!txt) { lastErr = `${model}: 빈 응답`; continue; }
      console.log(`[gemini] ${grounded ? "grounded" : "json"} 사용 모델: ${model} (${txt.length}자)`);
      return txt;
    } catch (e) { lastErr = `${model}: ${e.message}`; }
  }
  throw new Error(lastErr);
}

function extractJson(txt) {
  try { return JSON.parse(txt); } catch (e) {}
  const s = txt.indexOf("{"), e2 = txt.lastIndexOf("}");
  if (s >= 0 && e2 > s) { try { return JSON.parse(txt.slice(s, e2 + 1)); } catch (e) {} }
  return null;
}

// ---------- 검증기: 통과한 섹션만 반영한다 ----------
const isStr = (v, min = 1) => typeof v === "string" && v.trim().length >= min;

function vBrief(a) {
  if (!Array.isArray(a) || a.length !== 3) return null;
  const ok = a.every((b) => b && isStr(b.t) && isStr(b.c) && isStr(b.x, 120));
  return ok ? a.map((b) => ({ t: b.t, c: /neg/.test(b.c) ? "t-neg" : "t-pos", x: b.x })) : null;
}
function vScenarios(a) {
  if (!Array.isArray(a) || a.length !== 3) return null;
  const p = ["p-bull", "p-base", "p-bear"];
  const ok = a.every((s, i) => s && isStr(s.pl) && isStr(s.h) && isStr(s.d, 100));
  return ok ? a.map((s, i) => ({ pl: s.pl, h: s.h, p: p[i], d: s.d })) : null;
}
function vKV(a, min, max, minLen) {
  if (!Array.isArray(a) || a.length < min || a.length > max) return null;
  const ok = a.every((m) => m && isStr(m.k) && isStr(m.v, minLen));
  return ok ? a.map((m) => ({ k: m.k, v: m.v })) : null;
}
function vAiRows(a) {
  if (!Array.isArray(a) || a.length !== 4) return null;
  const names = ["Perplexity Pro", "Claude Max", "Gemini Pro", "ChatGPT Pro"];
  const vs = ["v-con", "v-dif", "v-dif", "v-solo"];
  const vts = ["팩트", "중립", "경계", "검증"];
  if (!a.every((r) => r && isStr(r.concl, 150))) return null;
  return a.map((r, i) => ({ ai: names[i], role: isStr(r.role) ? r.role : ["실시간 수집·출처", "심층 추론(중립)", "종합(경계)", "교차검증"][i], concl: r.concl, v: vs[i], vt: vts[i] }));
}
function vStocks(a) {
  if (!Array.isArray(a)) return null;
  const seen = new Set();
  const clean = [];
  for (const s of a) {
    if (!s) continue;
    const code = String(s.code || "").padStart(6, "0");
    if (!/^[0-9]{6}$/.test(code) || seen.has(code)) continue;
    if (!isStr(s.name) || !isStr(s.sum, 100)) continue;
    if (s.g !== "buy" && s.g !== "avoid") continue;
    const pts = Array.isArray(s.pts) ? s.pts.filter(isStr).slice(0, 2) : [];
    if (pts.length < 2) continue;
    seen.add(code);
    clean.push({
      g: s.g, code, name: s.name, sector: isStr(s.sector) ? s.sector : "기타",
      light: ["g", "y", "r"].includes(s.light) ? s.light : (s.g === "buy" ? "g" : "y"),
      score: Number.isFinite(+s.score) ? Math.max(0, Math.min(100, Math.round(+s.score))) : (s.g === "buy" ? 60 : 40),
      tone: isStr(s.tone) ? s.tone : (s.g === "buy" ? "낙관" : "비관"),
      conf: ["상", "중", "하"].includes(s.conf) ? s.conf : "중",
      ai: /^[2-4]\/4$/.test(s.ai) ? s.ai : "3/4",
      sum: s.sum, pts,
      risk: isStr(s.risk) ? s.risk : "시장 변동성·수급 변화.",
      out: isStr(s.out) ? s.out : "지표 확인하며 분할 접근.",
      src: isStr(s.src) ? s.src : "종합",
      url: /^https?:\/\//.test(s.url || "") ? s.url : "",
    });
  }
  const buy = clean.filter((s) => s.g === "buy").slice(0, 10);
  const avoid = clean.filter((s) => s.g === "avoid").slice(0, 10);
  // 각 그룹 8개 이상일 때만 반영 — 미달이면 기존 목록 유지
  if (buy.length < 8 || avoid.length < 8) return null;
  return buy.concat(avoid);
}
// watch는 기존 3종목의 sum/light/score만 갱신한다(코드·이름·링크는 보존).
function applyWatch(baseWatch, gen) {
  if (!Array.isArray(baseWatch) || !Array.isArray(gen)) return baseWatch;
  const byCode = {};
  gen.forEach((w) => { if (w && w.code) byCode[String(w.code).padStart(6, "0")] = w; });
  return baseWatch.map((w) => {
    const g = byCode[String(w.code).padStart(6, "0")];
    if (!g || !isStr(g.sum, 100)) return w;
    return Object.assign({}, w, {
      sum: g.sum,
      light: ["g", "y", "r"].includes(g.light) ? g.light : w.light,
      score: Number.isFinite(+g.score) ? Math.max(0, Math.min(100, Math.round(+g.score))) : w.score,
    });
  });
}

// ---------- 메인 ----------
(async () => {
  if (!KEY) { console.log("GEMINI_API_KEY 없음 — 스킵"); process.exit(0); }

  let base = {};
  try { base = JSON.parse(fs.readFileSync("content.json", "utf8")); }
  catch (e) { console.log("기존 content.json 읽기 실패 — 중단"); process.exit(1); }

  const today = todayKST();
  const when = SESSION === "open" ? "장 시작 전(오전 8시경)" : "장 마감 후(오후 4시경)";
  const [quoteCsv, macroCsv] = await Promise.all([getCsv(QUOTE_CSV), getCsv(MACRO_CSV)]);
  const quotes = parseQuotes(quoteCsv);
  const macro = parseMacro(macroCsv);
  console.log(`[data] 시세 ${quotes.length}종목, 매크로 ${macro.length}건`);

  // --- 1단계: 그라운딩 리서치 ---
  const researchPrompt = `오늘은 ${today}, 한국시간 ${when}이다. Google 검색을 사용해 한국 증시의 실제 최신 사실만 수집하고 한국어로 정리하라. 추측·창작 금지, 확인되지 않은 수치는 "확인 불가"로 표기하라.

반드시 포함할 항목:
1. ${SESSION === "open" ? "전 거래일" : "오늘"} 코스피·코스닥 지수 종가와 등라률(포인트·%)
2. 개인·외국인·기관 순매수/순매도 금액
3. 원/달러 환율 종가와 전일 대비
4. 상승·하락을 주도한 업종과 대표 종목(가능하면 종목명·등라률)
5. 시장을 움직인 뉴스·이벤트(실적, 지표, 정책, 지정학 등)와 증권가 코멘트
6. 간밤 또는 직전 미국 증시(S&P500·나스닥·다우) 등락과 미 국채 금리
7. 앞으로 1주일 내 예정된 주요 일정(금통위, 실적발표, 미 지표, 연준 이벤트)
8. 최근 부진하거나 밸류에이션 부담이 지적되는 업종·종목

각 항목 끝에 출처 매체명과 기사 URL을 [출처: 매체명 | URL] 형식으로 붙여라. 사실 나열 위주로 1,500자 이상 작성하라.

참고용 시세 데이터(구글파이낸스, 약 20분 지연):
${macro.length ? "매크로: " + macro.join(", ") : ""}
${quotes.length ? "종목: " + quotes.slice(0, 45).join(" / ") : ""}`;

  let research = "";
  try { research = await gemini(researchPrompt, { grounded: true, maxTokens: 4096 }); }
  catch (e) {
    console.log("[warn] 그라운딩 리서치 실패:", e.message);
    try { research = await gemini(researchPrompt.replace("Google 검색을 사용해 ", ""), { grounded: false, maxTokens: 4096 }); }
    catch (e2) { console.log("[warn] 폴백 리서치도 실패:", e2.message); }
  }
  if (!research || research.length < 200) {
    console.log("리서치 결과가 부실해 갱신을 건너뜁니다 — 기존 content.json 유지");
    process.exit(0);
  }

  // --- 2단계: 스키마 생성 ---
  const buildPrompt = `당신은 한국 주식시장 애널리스트다. 아래 [리서치]에 담긴 사실만을 근거로 대시보드 콘텐츠를 만든다. 리서치에 없는 수치는 절대 지어내지 말고, 없으면 정성적으로 서술하라. 과장·확정적 매매권유 금지. 오늘은 ${today}, ${when}이다.

[리서치]
${research}

[참고 시세(약 20분 지연)]
${macro.join(", ")}
${quotes.slice(0, 45).join(" / ")}

아래 JSON만 출력하라(설명·마크다운 없이 JSON 객체 하나):
{
 "brief":[{"t":"현황","c":"t-pos 또는 t-neg","x":"5~8문장. 지수·수급·환율 등 구체적 수치 포함. 마지막 문장은 반드시 '정보 정리이며 투자자문이 아니다.'"},
          {"t":"동인","c":"...","x":"5~8문장. 오늘 시장을 움직인 원인을 ①②로 구조화."},
          {"t":"주의","c":"t-neg","x":"5~8문장. 리스크 요인. 마지막 문장은 반드시 '정보 정리이며 투자자문이 아니다.'"}],
 "scenarios":[{"pl":"상승 시나리오","h":"강세","d":"4문장 이상"},{"pl":"중립 시나리오","h":"기본","d":"4문장 이상"},{"pl":"조정 시나리오","h":"약세","d":"4문장 이상"}],
 "consensusTxt":"<b>합의:</b> ... <b>이견:</b> ...",
 "monitor":[{"k":"지표명","v":"2~4문장의 구체적 설명"}],
 "globalNote":"미국 증시·금리·글로벌 이벤트를 다룬 6문장 이상의 한 문단",
 "aiRows":[{"role":"실시간 수집·출처","concl":"사실·수치 나열 중심 6문장 이상"},
           {"role":"심층 추론(중립)","concl":"균형 잡힌 해석 6문장 이상"},
           {"role":"종합(경계)","concl":"리스크 중심 6문장 이상"},
           {"role":"교차검증","concl":"위 수치들의 출처·일치 여부를 점검하고 불확실한 항목을 명시. 6문장 이상"}],
 "stocks":[ ... ],
 "watch":[{"code":"035720","light":"g|y|r","score":0~100,"sum":"오늘 상황 기준 5문장 이상"},
          {"code":"004020","light":"...","score":0,"sum":"..."},
          {"code":"402340","light":"...","score":0,"sum":"..."}]
}

monitor는 6~8개 항목(코스피 지수, 코스닥, 수급, 원/달러 환율, 금리·통화정책, 반도체·주도업종, 글로벌 이벤트, 소외 업종 등).

stocks는 정확히 20개: g:"buy" 10개 + g:"avoid" 10개.
각 종목 형식:
{"g":"buy","code":"005930","name":"삼성전자","sector":"반도체","light":"g","score":66,"tone":"낙관","conf":"상","ai":"4/4","sum":"4~6문장. 리서치의 사실을 근거로 오늘 왜 관심/주의인지 설명","pts":["핵심 근거 1","핵심 근거 2"],"risk":"위험 요인 한 문장","out":"대응 관점 한 문장","src":"출처 매체명","url":"리서치에 나온 실제 기사 URL"}

엄격한 규칙:
- code는 반드시 실제 존재하는 한국 상장사의 정확한 6자리 종목코드. 확실하지 않으면 그 종목을 빼고 확실한 다른 종목을 넣어라.
- 섹터를 분산하라. 반도체에만 몰지 말고 금융·조선·방산·원전·전력기기·통신·필수소비·바이오·인터넷·2차전지·자동차·유틸리티·로봇·철강·정유 중에서 고르게 배분한다.
- buy는 light "g"(일부 "y"), avoid는 "y" 또는 "r"을 쓴다.
- url은 리서치의 [출처] URL 중에서 고르고, 마땅한 것이 없으면 빈 문자열 ""로 둔다. URL을 지어내지 마라.
- 모든 문장은 한국어 평서체(~다)로 쓴다.`;

  let gen = null;
  for (let attempt = 1; attempt <= 2 && !gen; attempt++) {
    try {
      const txt = await gemini(buildPrompt, { grounded: false, maxTokens: 16384 });
      gen = extractJson(txt);
      if (!gen) console.log(`[warn] ${attempt}차 JSON 파싱 실패`);
    } catch (e) { console.log(`[warn] ${attempt}차 생성 실패:`, e.message); }
  }
  if (!gen) { console.log("생성 실패 — 기존 content.json 유지"); process.exit(0); }

  const nBrief = vBrief(gen.brief);
  const nScen = vScenarios(gen.scenarios);
  const nMon = vKV(gen.monitor, 5, 9, 30);
  const nAi = vAiRows(gen.aiRows);
  const nStocks = vStocks(gen.stocks);

  const report = {
    brief: !!nBrief, scenarios: !!nScen, monitor: !!nMon, aiRows: !!nAi,
    stocks: nStocks ? nStocks.length : 0,
  };
  console.log("[검증]", JSON.stringify(report));

  // 핵심 섹션(brief)과 종목이 모두 실패하면 커밋할 가치가 없다.
  if (!nBrief && !nStocks) { console.log("핵심 섹션 검증 실패 — 기존 content.json 유지"); process.exit(0); }

  const out = Object.assign({}, base, {
    updated: today,
    brief: nBrief || base.brief,
    scenarios: nScen || base.scenarios,
    consensusTxt: isStr(gen.consensusTxt, 60) ? gen.consensusTxt : base.consensusTxt,
    monitor: nMon || base.monitor,
    globalNote: isStr(gen.globalNote, 200) ? gen.globalNote : base.globalNote,
    aiRows: nAi || base.aiRows,
    stocks: nStocks || base.stocks,
    watch: applyWatch(base.watch, gen.watch),
  });

  // 최종 안전장치: 직렬화·재파싱 확인
  const json = JSON.stringify(out, null, 1);
  JSON.parse(json);
  fs.writeFileSync("content.json", json);
  console.log(`content.json 갱신 완료: ${out.updated} (${SESSION}) / stocks=${out.stocks.length}`);
})().catch((e) => { console.error("치명적 오류:", e); process.exit(1); });
