/**
 * 智能识别（中文时间解析）断言测试
 *
 * 直接在浏览器里加载线上的 index.html 并调用其中的 parseZh，
 * 测的就是真正发布的代码，不是副本。
 *
 * 跑法：node test/parser.test.cjs
 */
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PORT = 8399;
const NOW = "2026-07-28T19:09:00";   // 固定“当前时间”，结果才可复现

// [输入, 期望提醒时刻, 期望内容, 期望事件时刻(可选)]
const CASES = [
  ["十分钟后测试",                          "2026-07-28 19:19", "测试"],
  ["10分钟后 开会",                         "2026-07-28 19:19", "开会"],
  ["2小时后 回复邮件",                      "2026-07-28 21:09", "回复邮件"],
  ["半小时后喝水",                          "2026-07-28 19:39", "喝水"],
  ["3天后 交报告",                          "2026-07-31 09:00", "交报告"],
  // 现在 19:09，今天 15:30 已过 → 应顺延到明天
  ["下午3点半 去接孩子",                    "2026-07-29 15:30", "去接孩子"],
  ["今晚提醒我倒垃圾",                      "2026-07-28 20:00", "倒垃圾"],
  ["明早9点 吃药",                          "2026-07-29 09:00", "吃药"],
  ["明天早上十点，查看银行卡余额，提前5分钟提醒我",
                                            "2026-07-29 09:55", "查看银行卡余额", "2026-07-29 10:00"],
  ["7月28日上午11点5分开会，提前两分钟提醒我",
                                            "2026-07-28 11:03", "开会",           "2026-07-28 11:05"],
  ["9:05 打卡",                             "2026-07-29 09:05", "打卡"],   // 今天 9:05 已过 → 顺延明天
  ["买菜",                                  null,               null],
];

const MIME = { ".html": "text/html", ".js": "application/javascript",
               ".png": "image/png", ".webmanifest": "application/json" };

(async () => {
  const server = http.createServer((req, res) => {
    let f = req.url.split("?")[0];
    if (f === "/") f = "/index.html";
    const fp = path.join(ROOT, f);
    fs.readFile(fp, (e, d) => {
      if (e) { res.writeHead(404); return res.end("nf"); }
      res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "text/plain" });
      res.end(d);
    });
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "networkidle" });

  let pass = 0, fail = 0;

  for (const [input, wantAt, wantText, wantEvent] of CASES) {
    const got = await page.evaluate(([text, nowStr]) => {
      const r = window.__parseZh(text, new Date(nowStr));
      if (!r) return null;
      const f = (ts) => {
        const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      };
      return { at: f(r.remindTs), event: f(r.eventTs), text: r.clean };
    }, [input, NOW]);

    const problems = [];
    if (wantAt === null) {
      if (got !== null) problems.push(`期望不识别，实际识别为 ${got.at}`);
    } else if (got === null) {
      problems.push("期望识别出时间，实际没识别");
    } else {
      if (got.at !== wantAt) problems.push(`提醒时刻 期望 ${wantAt}，实际 ${got.at}`);
      if (got.text !== wantText) problems.push(`内容 期望「${wantText}」，实际「${got.text}」`);
      if (wantEvent && got.event !== wantEvent) problems.push(`事件时刻 期望 ${wantEvent}，实际 ${got.event}`);
    }

    if (problems.length) {
      fail++;
      console.log(`  ❌ ${input}`);
      problems.forEach((p) => console.log(`       ${p}`));
    } else {
      pass++;
      console.log(`  ✅ ${input}${got ? "  →  " + got.at + (got.text ? " 《" + got.text + "》" : "") : "  →  (不识别)"}`);
    }
  }

  if (errs.length) { console.log("\n页面报错:", errs.join(" | ")); fail++; }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})();
