/* 공유 카드(og-image.png) 생성.
   날짜·시세를 넣지 않는다 — 이미지는 메신저·SNS에 길게 캐시돼 옛 숫자가 '오늘 값'처럼 남는다.
   (2026-08-27에 만든 카드가 2026-10-31까지 "코스피 6894.42"를 보여주고 있었다.) */
const fs = require("fs");
const { chromium } = require("playwright");

const HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#f5f6f8;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo",sans-serif;
    display:flex;align-items:center;justify-content:center}
  .card{width:1080px;height:510px;background:#fff;border:1px solid #e6e9ee;border-radius:28px;
    box-shadow:0 18px 50px rgba(20,28,45,.10);padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between}
  .top{display:flex;align-items:center;gap:14px}
  .pill{font-size:20px;font-weight:700;color:#3b5bdb;background:#eef1fe;border:1px solid #d9e0fb;
    border-radius:999px;padding:7px 18px}
  h1{font-size:72px;font-weight:800;letter-spacing:-1.5px;color:#1a1d21;line-height:1.1;margin-top:26px}
  p.lead{font-size:30px;color:#5b636e;line-height:1.5;margin-top:20px;max-width:880px}
  .bars{display:flex;gap:10px;margin-top:34px}
  .bars i{display:block;height:12px;border-radius:999px}
  .foot{display:flex;align-items:center;justify-content:space-between;border-top:1px solid #e6e9ee;padding-top:24px}
  .foot b{font-size:24px;color:#1a1d21;font-weight:700}
  .foot span{font-size:21px;color:#686f79}
</style></head><body>
  <div class="card">
    <div>
      <div class="top"><span class="pill">정보 도구 · 투자자문 아님</span></div>
      <h1>국내증시 대시보드</h1>
      <p class="lead">코스피·환율·업종 흐름과 AI가 정리한 오늘의 국내 증시를<br>한 화면에서 쉬운 말로 봅니다.</p>
      <div class="bars">
        <i style="width:210px;background:#c92f2f"></i>
        <i style="width:150px;background:#1a66c2"></i>
        <i style="width:96px;background:#1f9d5b"></i>
        <i style="width:64px;background:#d98a00"></i>
        <i style="width:40px;background:#e6e9ee"></i>
      </div>
    </div>
    <div class="foot"><b>realchm-svg.github.io/stock-dashboard</b><span>하루 두 번 갱신 · 시세 약 20분 지연</span></div>
  </div>
</body></html>`;

(async () => {
  const b = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const pg = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await pg.setContent(HTML, { waitUntil: "load" });
    await pg.waitForTimeout(250);
    await pg.screenshot({ path: "og-image.png" });
    console.log("og-image.png 생성 완료:", fs.statSync("og-image.png").size, "bytes");
  } finally {
    await b.close();
  }
})().catch((e) => { console.error("og 생성 실패:", e.message); process.exit(1); });
