/**
 * 一键部署脚本：把「建数据库 / 生成密钥 / 建表 / 上线」全部自动做完。
 * 用法：npm run setup
 *
 * 跨平台（Windows / macOS / Linux 都能跑），不需要懂命令行。
 */
import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const TOML = new URL("./wrangler.toml", import.meta.url);
const DB_NAME = "light-reminder";

const say = (s) => console.log(s);
const step = (n, s) => console.log(`\n\x1b[36m[${n}]\x1b[0m ${s}`);
const okp = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
}
function runLive(cmd) {
  const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`命令执行失败：${cmd}`);
}
function patchToml(key, value) {
  let t = readFileSync(TOML, "utf8");
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)".*?"`, "m");
  if (!re.test(t)) throw new Error(`wrangler.toml 里找不到 ${key}`);
  t = t.replace(re, `$1"${value}"`);
  writeFileSync(TOML, t);
}
function tomlValue(key) {
  const m = readFileSync(TOML, "utf8").match(new RegExp(`^\\s*${key}\\s*=\\s*"(.*?)"`, "m"));
  return m ? m[1] : "";
}

say("\n\x1b[1m轻提醒 · 推送后端一键部署\x1b[0m");
say("————————————————————————————————");

/* 1. 登录检查 */
step(1, "检查 Cloudflare 登录状态");
const hasToken = !!process.env.CLOUDFLARE_API_TOKEN;

let logged = false;
try {
  const who = run("npx wrangler whoami");
  logged = !/not authenticated|You are not logged in/i.test(who);
} catch (e) { logged = false; }

if (logged) {
  okp(hasToken ? "已通过 API Token 认证" : "已登录");
} else if (hasToken) {
  throw new Error(
    "检测到 CLOUDFLARE_API_TOKEN，但校验没通过。\n" +
    "  请确认 Token 没复制错、且具备 Workers Scripts:Edit 与 D1:Edit 权限。"
  );
} else {
  warn("尚未登录，即将打开浏览器，请点 Allow 授权");
  try {
    runLive("npx wrangler login");
    okp("登录完成");
  } catch (e) {
    say("");
    say("\x1b[33m浏览器授权失败了（常见于公司电脑：策略限制导致 wrangler 无法拉起浏览器，");
    say("报错形如 spawn UNKNOWN）。\x1b[0m");
    say("");
    say("请改用 \x1b[1mAPI Token\x1b[0m 方式，三步：");
    say("  1. 打开 https://dash.cloudflare.com/profile/api-tokens");
    say("     Create Token → Custom token，勾选权限：");
    say("       Account | Workers Scripts | Edit");
    say("       Account | D1              | Edit");
    say("       Account | Account Settings| Read");
    say("  2. 复制生成的 Token，在本窗口执行（等号两边不要留空格）：");
    say("       \x1b[36mset CLOUDFLARE_API_TOKEN=你的Token\x1b[0m");
    say("  3. 重新运行：\x1b[36mnpm run setup\x1b[0m");
    say("");
    throw new Error("需要先完成认证");
  }
}

/* 2. 数据库 */
step(2, "创建数据库");
let dbId = "";
try {
  const out = run(`npx wrangler d1 create ${DB_NAME}`);
  const m = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (m) { dbId = m[0]; okp(`已创建，id = ${dbId}`); }
} catch (e) {
  const msg = String(e.stdout || "") + String(e.stderr || "") + String(e.message || "");
  if (/already exists/i.test(msg)) warn("数据库已存在，沿用现有的");
  else warn("创建返回异常，尝试从账号里查找现有数据库");
}

if (!dbId) {
  // 已存在时从列表里取 id
  try {
    const list = run("npx wrangler d1 list --json");
    const arr = JSON.parse(list.slice(list.indexOf("[")));
    const hit = arr.find((d) => d.name === DB_NAME);
    if (hit) { dbId = hit.uuid || hit.database_id || hit.id; okp(`找到现有数据库，id = ${dbId}`); }
  } catch (e) {}
}
if (!dbId) {
  throw new Error("拿不到数据库 id，请手动执行：npx wrangler d1 create " + DB_NAME);
}
patchToml("database_id", dbId);
okp("已写入 wrangler.toml");

/* 3. 建表 */
step(3, "创建数据表");
runLive(`npx wrangler d1 execute ${DB_NAME} --remote --file=schema.sql --yes`);
okp("数据表就绪");

/* 4. 推送密钥 */
step(4, "生成推送密钥（VAPID）");
if (tomlValue("VAPID_PUBLIC_KEY")) {
  warn("检测到已有公钥，跳过生成（如需重置请清空 wrangler.toml 中的 VAPID_PUBLIC_KEY）");
} else {
  const kp = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
  );
  const pub = Buffer.from(await crypto.subtle.exportKey("raw", kp.publicKey)).toString("base64url");
  const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey));

  patchToml("VAPID_PUBLIC_KEY", pub);
  okp("公钥已写入 wrangler.toml");

  run("npx wrangler secret put VAPID_PRIVATE_JWK", { input: jwk, stdio: ["pipe", "inherit", "inherit"] });
  okp("私钥已安全保存到 Cloudflare（不会出现在代码里）");
}

/* 5. 上线 */
step(5, "部署上线");
runLive("npx wrangler deploy");

/* 6. 结果 */
let url = "";
try {
  const out = run("npx wrangler deployments list --json");
  const m = out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i);
  if (m) url = m[0];
} catch (e) {}

say("\n————————————————————————————————");
say("\x1b[32m\x1b[1m✅ 部署完成！\x1b[0m\n");
if (url) {
  say("你的后端地址（复制到手机 App 里）：");
  say(`\n    \x1b[36m\x1b[1m${url}\x1b[0m\n`);
} else {
  say("请在上方 deploy 输出里找到形如下面的地址，复制到手机 App：");
  say("\n    https://light-reminder-push.你的用户名.workers.dev\n");
}
say("接下来在手机上：");
say("  1. 用 Safari 打开 App 网址 → 分享 → 添加到主屏幕");
say("  2. 从桌面图标打开 App → 点「云端推送」→「设置」");
say("  3. 粘贴上面的地址 → 点「连接」→ 允许通知");
say("  4. 点「发送测试推送」→ 锁屏 → 应该收到通知 🎉\n");
