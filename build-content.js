// content.json 자동 갱신 스크립트 (GitHub Actions에서 평일 2회 실행)
// 2단계 파이프라인:
//   1) Gemini + Google Search 그라운딩으로 오늘의 실제 시장 사실을 수집 (수치·출처 포함)
//   2) 그 사실만을 근거로 대시보드 전체 스키마(JSON)를 생성
// 검증을 통과한 섹션만 반영하고, 실패한 섹션은 기존 값을 유지한다(안전판).
// 필요 환경변수: GEMINI_API_KEY (필수), ANTHROPIC_API_KEY·OPENAI_API_KEY (AI 패널용, 없으면 그 칸은 비운다)
// 모델은 실행 시점에 각 회사 목록 API 에서 '가장 좋은 것'을 골라 쓴다.
// ANTHROPIC_MODEL / OPENAI_MODEL / GEMINI_MODEL 로 직접 지정할 수도 있다.
// Node 20+ (전역 fetch)

const fs = require("fs");

const QUOTE_CSV = "https://docs.google.com/spreadsheets/d/1pLFiMYoEJ9VHzYfucEVrfWcLKyj91DKi-My5rlaLAbc/gviz/tq?tqx=out:csv";
const MACRO_CSV = "https://docs.google.com/spreadsheets/d/1eeEwRXUiExYa-wt6IFq3dyvcvqHhvJxls84dLp-XuIw/gviz/tq?tqx=out:csv";
const KEY = process.env.GEMINI_API_KEY || "";
const MODELS = process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-pro"];
// SESSION=open(장 시작 전) | close(마감 후). 워크플로에서 주입.
const SESSION = (process.env.SESSION || "close").toLowerCase();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";

/* --- 진단 기록: 매 실행 결과를 last-run.json으로 남긴다 (조용한 실패 방지) --- */
const __log = [];
let __panelNames = "";
/* 조용히 넘어가지 않는다: 갱신 못 하면 워크플로를 실패시켜 메일이 오게 한다 */
function __bail() {
  const last = __log.length ? __log[__log.length - 1] : "원인 불명";
  console.log("::error::대시보드 갱신 실패 — " + last);
  process.exit(1);
}
const __origLog = console.log;
console.log = function () {
  const a = Array.prototype.slice.call(arguments);
  __log.push(a.map(function (x) { return typeof x === "string" ? x : JSON.stringify(x); }).join(" "));
  __origLog.apply(console, a);
};
process.on("exit", function (code) {
  try {
    const joined = __log.join("\n");
    const ok = joined.indexOf("content.json 갱신 완료") >= 0;
    const bad = __log.filter(function (l) { return /유지|스킵|중단|실패|부실/.test(l); });
    fs.writeFileSync("last-run.json", JSON.stringify({
      ranAt: new Date().toISOString(),
      session: SESSION,
      panel: (typeof __panelNames !== "undefined" ? __panelNames : ""),
      status: ok ? "updated" : "skipped",
      reason: ok ? "" : (bad.length ? bad[bad.length - 1] : "알 수 없음"),
      exitCode: code,
      log: __log.slice(-40)
    }, null, 1));
  } catch (e) {}
});


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
      generationConfig: {
        temperature: grounded ? 0.2 : 0.45,
        /* 모델마다 출력 상한이 달라 넘기면 400이 난다 — 2.0-flash는 8192가 한계 */
        maxOutputTokens: Math.min(maxTokens, /2\.0-flash/.test(model) ? 8192 : 65000),
      },
    };
    /* 2.5 계열은 생각 토큰이 출력 한도를 먹어 응답이 잘린다 — flash는 끄고 pro는 최소치로 */
    if (/2\.5-flash/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    else if (/2\.5-pro/.test(model)) body.generationConfig.thinkingConfig = { thinkingBudget: 128 };
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

/* ═══════════ AI 패널: Claude · ChatGPT · Gemini 를 실제로 호출한다 ═══════════
   예전에는 Gemini 한 곳의 답을 네 조각으로 쪼개 놓고 네 회사 이름을 붙였다.
   이제는 회사마다 진짜로 부르고, 응답하지 않은 곳은 그 사실을 그대로 적는다. */

async function fetchJSON(url, opt, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 90000);
  try {
    const r = await fetch(url, Object.assign({ signal: ac.signal }, opt || {}));
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (e) {}
    return { ok: r.ok, status: r.status, json: j, text: txt };
  } finally { clearTimeout(t); }
}

/* 각 회사의 모델 목록을 받아 '가장 좋은 것'을 고른다 — 새 모델이 나오면 자동으로 따라간다 */
function rankBy(list, tiers, bad) {
  const cand = list.filter((m) => !bad.some((b) => m.id.includes(b)));
  for (const t of tiers) {
    const hit = cand.filter((m) => t.test(m.id));
    if (hit.length) { hit.sort((a, b) => (b.at || 0) - (a.at || 0) || (b.id > a.id ? 1 : -1)); return hit[0].id; }
  }
  return null;
}

async function pickAnthropicModel() {
  if (process.env.ANTHROPIC_MODEL) return process.env.ANTHROPIC_MODEL;
  const r = await fetchJSON("https://api.anthropic.com/v1/models?limit=100",
    { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" } }, 30000);
  if (!r.ok || !r.json || !Array.isArray(r.json.data)) return null;
  const list = r.json.data.map((m) => ({ id: m.id, at: Date.parse(m.created_at || "") || 0 }));
  /* 성능 높은 계열부터 — 이름이 바뀌어도 걸리도록 넓게 본다 */
  return rankBy(list, [/opus/i, /sonnet/i, /haiku/i, /./], []);
}

async function pickOpenAIModel() {
  if (process.env.OPENAI_MODEL) return process.env.OPENAI_MODEL;
  const r = await fetchJSON("https://api.openai.com/v1/models",
    { headers: { Authorization: "Bearer " + OPENAI_KEY } }, 30000);
  if (!r.ok || !r.json || !Array.isArray(r.json.data)) return null;
  const list = r.json.data.map((m) => ({ id: m.id, at: (m.created || 0) * 1000 }));
  const bad = ["mini", "nano", "audio", "realtime", "embedding", "tts", "whisper", "image", "moderation", "search", "transcribe", "instruct", "codex-mini"];
  /* 숫자가 큰 세대부터 — gpt-6 → gpt-5 → gpt-4.x 순으로 본다 */
  return rankBy(list, [/^gpt-[6-9]/, /^gpt-5/, /^o[3-9]/, /^gpt-4\.[1-9]/, /^gpt-4o/, /^gpt-4/], bad);
}

async function pickGeminiModel() {
  if (process.env.GEMINI_PANEL_MODEL) return process.env.GEMINI_PANEL_MODEL;
  const r = await fetchJSON("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(KEY), {}, 30000);
  if (!r.ok || !r.json || !Array.isArray(r.json.models)) return "gemini-2.5-pro";
  const list = r.json.models
    .filter((m) => Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods.includes("generateContent") : true)
    .map((m) => ({ id: String(m.name || "").replace(/^models\//, ""), at: 0 }));
  const bad = ["embedding", "aqa", "vision", "image", "tts", "live", "thinking-exp"];
  return rankBy(list, [/[3-9]\..*pro/, /pro/, /[3-9]\..*flash/, /flash/, /./], bad) || "gemini-2.5-pro";
}

async function askAnthropic(model, prompt) {
  const r = await fetchJSON("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
  }, 120000);
  if (!r.ok) throw new Error("anthropic " + r.status + " " + (r.json && r.json.error ? r.json.error.message : r.text.slice(0, 120)));
  const parts = (r.json && r.json.content) || [];
  const txt = parts.map((p) => (p && p.type === "text" ? p.text : "")).join("").trim();
  if (!txt) throw new Error("anthropic 빈 응답");
  return txt;
}

async function askOpenAI(model, prompt) {
  /* 모델마다 받는 옵션이 달라 temperature·토큰 상한을 보내지 않는다(기본값 사용) */
  const r = await fetchJSON("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + OPENAI_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  }, 180000);
  if (!r.ok) throw new Error("openai " + r.status + " " + (r.json && r.json.error ? r.json.error.message : r.text.slice(0, 120)));
  const c = r.json && r.json.choices && r.json.choices[0];
  const txt = ((c && c.message && c.message.content) || "").trim();
  if (!txt) throw new Error("openai 빈 응답");
  return txt;
}

async function askGemini(model, prompt) {
  const r = await fetchJSON(
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(KEY),
    {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: Object.assign(
          { temperature: 0.4, maxOutputTokens: /2\.0-flash/.test(model) ? 8192 : 16000 },
          /2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : {}
        ),
      }),
    }, 150000);
  if (!r.ok || (r.json && r.json.error)) throw new Error("gemini " + r.status + " " + ((r.json && r.json.error && r.json.error.message) || r.text.slice(0, 120)));
  const parts = (r.json && r.json.candidates && r.json.candidates[0] && r.json.candidates[0].content && r.json.candidates[0].content.parts) || [];
  const txt = parts.map((p) => p.text || "").join("").trim();
  if (!txt) throw new Error("gemini 빈 응답");
  return txt;
}

/* 같은 자료를 세 회사에 똑같이 던지고, 각자 맡은 관점으로 답하게 한다 */
async function runPanel(research, macro, quotes) {
  const common = `당신은 한국 주식시장을 보는 애널리스트다. 아래 [오늘 수집한 사실]만을 근거로 답하라.
여기에 없는 수치는 절대 지어내지 마라. 사라거나 팔라는 단정적 권유는 쓰지 마라.
주식을 잘 모르는 사람도 알아듣게 쉬운 한국어로 쓴다. 전문용어는 쓰되 괄호로 짧게 풀어 준다.

[오늘 수집한 사실]
${research}

[참고 시세(약 20분 지연)]
${macro.join(", ")}
${quotes.slice(0, 40).join(" / ")}
`;
  const seats = [
    {
      id: "claude", label: "Claude", role: "심층 추론", v: "v-dif", vt: "중립", key: ANTHROPIC_KEY,
      pick: pickAnthropicModel, ask: askAnthropic,
      task: "오늘 시장이 왜 그렇게 움직였는지, 원인과 결과를 따져서 6문장 이상으로 정리하라. 표면적인 뉴스 나열이 아니라 '무엇이 무엇을 밀었는지'를 밝혀라. 다른 설명이나 머리말 없이 본문만 쓴다.",
    },
    {
      id: "openai", label: "ChatGPT", role: "교차 검증", v: "v-solo", vt: "검증", key: OPENAI_KEY,
      pick: pickOpenAIModel, ask: askOpenAI,
      task: "위 자료 안에서 서로 어긋나거나 근거가 약한 대목을 찾아 6문장 이상으로 짚어라. 숫자가 출처마다 다르면 그 사실을 적고, 확인된 것과 확인되지 않은 것을 나눠라. 다른 설명이나 머리말 없이 본문만 쓴다.",
    },
    {
      id: "gemini", label: "Gemini", role: "종합·경계", v: "v-dif", vt: "경계", key: KEY,
      pick: pickGeminiModel, ask: askGemini,
      task: "오늘 자료를 종합하되 낙관에 기울지 말고, 앞으로 경계해야 할 것을 6문장 이상으로 정리하라. 무엇이 틀어지면 지금 판단이 바뀌는지 구체적으로 적어라. 다른 설명이나 머리말 없이 본문만 쓴다.",
    },
  ];

  const results = await Promise.all(seats.map(async (st) => {
    if (!st.key) { console.log("[panel] " + st.label + ": 열쇠 없음 — 건너뜀"); return null; }
    try {
      const model = await st.pick();
      if (!model) throw new Error("쓸 수 있는 모델을 찾지 못함");
      const t0 = Date.now();
      const txt = await st.ask(model, common + "\n[맡은 역할] " + st.role + "\n" + st.task);
      console.log("[panel] " + st.label + " ← " + model + " (" + txt.length + "자, " + Math.round((Date.now() - t0) / 1000) + "초)");
      return { ai: st.label + " · " + model, role: st.role, concl: txt.replace(/\s+/g, " ").trim().slice(0, 2000), v: st.v, vt: st.vt };
    } catch (e) {
      console.log("[panel] " + st.label + " 실패: " + e.message);
      return null;
    }
  }));

  const rows = results.filter(Boolean);
  __panelNames = rows.map((r) => r.ai).join(" | ");
  console.log("[panel] 실제로 답한 AI: " + rows.length + "곳 (" + rows.map((r) => r.ai.split(" · ")[0]).join(", ") + ")");
  return rows;
}

/* 실제 답변들을 놓고 합의와 이견을 정리한다 — 답한 곳이 2곳 미만이면 합의를 말하지 않는다 */
async function panelConsensus(rows) {
  if (rows.length < 2) return "";
  const body = rows.map((r, i) => "[" + (i + 1) + "] " + r.ai.split(" · ")[0] + " (" + r.role + ")\n" + r.concl).join("\n\n");
  const p = `아래는 서로 다른 회사의 AI ${rows.length}곳이 같은 자료를 보고 각자 쓴 글이다.
공통으로 말한 것과 서로 갈린 것을 찾아 한국어 두 문장으로 정리하라.
형식은 정확히 이렇게: <b>합의:</b> ... <b>이견:</b> ...
없는 내용을 지어내지 말고, 투자 권유 표현은 쓰지 마라. 다른 말 없이 그 두 문장만 출력하라.

${body}`;
  try {
    const txt = await gemini(p, { grounded: false, maxTokens: 2000 });
    const m = String(txt).replace(/```[a-z]*|```/g, "").trim();
    if (m.includes("합의") && m.length > 20) return m.slice(0, 900);
  } catch (e) { console.log("[panel] 합의 정리 실패: " + e.message); }
  return "";
}

function extractJson(txt) {
  const r = extractJsonBasic(txt);
  if (r) return r;
  return repairJson(txt);
}
/* 응답이 중간에 잘렸을 때 마지막으로 온전히 닫힌 항목까지만 살려 쓴다 */
function repairJson(txt) {
  const s0 = txt.indexOf("{");
  if (s0 < 0) return null;
  const body = txt.slice(s0);
  let depth = 0, inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === "\"") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") { depth--; if (depth > 0) lastSafe = i; }
  }
  if (lastSafe < 0) return null;
  const st = [];
  let q = false, e2 = false;
  for (let i = 0; i <= lastSafe; i++) {
    const ch = body[i];
    if (e2) { e2 = false; continue; }
    if (ch === "\\") { e2 = true; continue; }
    if (ch === "\"") { q = !q; continue; }
    if (q) continue;
    if (ch === "{" || ch === "[") st.push(ch);
    else if (ch === "}" || ch === "]") st.pop();
  }
  const tail = st.reverse().map(function (c) { return c === "{" ? "}" : "]"; }).join("");
  try { return JSON.parse(body.slice(0, lastSafe + 1) + tail); } catch (e) {}
  return null;
}
function extractJsonBasic(txt) {
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
  /* 실제로 답한 AI 수만큼만 칸이 생긴다 — 예전처럼 네 칸을 억지로 채우지 않는다 */
  if (!Array.isArray(a) || a.length < 2 || a.length > 5) return null;
  /* 이 스크립트는 Gemini 한 모델만 호출한다. 네 칸에 다른 회사 이름을 붙이면
     "AI 네 곳이 각각 답했다"는 거짓이 된다 — 역할 이름만 쓴다(2026-10-31). */
  const names = ["사실 수집·출처", "심층 추론", "반대 근거 점검", "교차 확인"];
  const vs = ["v-con", "v-dif", "v-dif", "v-solo"];
  const vts = ["팩트", "중립", "경계", "검증"];
  if (!a.every((r) => r && isStr(r.concl, 150))) return null;
  return a.map((r, i) => ({ ai: names[i], role: isStr(r.role) ? r.role : names[i], concl: r.concl, v: vs[i], vt: vts[i] }));
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
  if (!KEY) { console.log("GEMINI_API_KEY 없음 — 스킵"); __bail(); }

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
  try { research = await gemini(researchPrompt, { grounded: true, maxTokens: 8192 }); }
  catch (e) {
    console.log("[warn] 그라운딩 리서치 실패:", e.message);
    try { research = await gemini(researchPrompt.replace("Google 검색을 사용해 ", ""), { grounded: false, maxTokens: 8192 }); }
    catch (e2) { console.log("[warn] 폴백 리서치도 실패:", e2.message); }
  }
  if (!research || research.length < 800) {
    console.log("리서치 결과가 부실해 갱신을 건너뜁니다 — 기존 content.json 유지");
    __bail();
  }

  // --- 1.5단계: AI 패널 — Claude·ChatGPT·Gemini 를 실제로 호출한다 ---
  const panelP = runPanel(research, macro, quotes).catch((e) => { console.log("[panel] 전체 실패: " + e.message); return []; });

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
      const txt = await gemini(buildPrompt, { grounded: false, maxTokens: 60000 });
      gen = extractJson(txt);
      if (!gen) console.log(`[warn] ${attempt}차 JSON 파싱 실패`);
    } catch (e) { console.log(`[warn] ${attempt}차 생성 실패:`, e.message); }
  }
  if (!gen) { console.log("생성 실패 — 기존 content.json 유지"); __bail(); }

  const nBrief = vBrief(gen.brief);
  const nScen = vScenarios(gen.scenarios);
  const nMon = vKV(gen.monitor, 5, 9, 30);
  /* 실제로 답한 AI가 2곳 이상이면 그 답을 쓴다. 한 곳 이하면 Gemini 가 만든 칸을 쓰되,
     회사 이름을 붙이지 않으므로 "네 곳이 답했다"는 거짓은 생기지 않는다. */
  const panelRows = await panelP;
  const panelOk = Array.isArray(panelRows) && panelRows.length >= 2;
  const nAi = panelOk ? vAiRows(panelRows) : vAiRows(gen.aiRows);
  const panelCons = panelOk ? await panelConsensus(panelRows) : "";
  console.log("[panel] 화면에 쓰는 칸: " + (panelOk ? "실제 호출 " + panelRows.length + "곳" : "Gemini 생성 칸(역할만 표기)"));
  const nStocks = vStocks(gen.stocks);

  const report = {
    brief: !!nBrief, scenarios: !!nScen, monitor: !!nMon, aiRows: !!nAi,
    stocks: nStocks ? nStocks.length : 0,
  };
  console.log("[검증]", JSON.stringify(report));

  // 핵심 섹션(brief)과 종목이 모두 실패하면 커밋할 가치가 없다.
  if (!nBrief && !nStocks) { console.log("핵심 섹션 검증 실패 — 기존 content.json 유지"); __bail(); }

  const out = Object.assign({}, base, {
    updated: today,
    brief: nBrief || base.brief,
    scenarios: nScen || base.scenarios,
    consensusTxt: isStr(panelCons, 40) ? panelCons : (isStr(gen.consensusTxt, 60) ? gen.consensusTxt : base.consensusTxt),
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
