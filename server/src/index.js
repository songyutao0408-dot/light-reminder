/**
 * 轻提醒 · 推送后端（Cloudflare Worker）
 *
 * - fetch()     ：给前端调用的 API（订阅、同步提醒、测试推送）
 * - scheduled() ：每分钟扫描一次到期提醒，主动推送到手机
 *
 * 手机锁屏、App 关闭时，提醒由这里发出，不依赖网页是否在运行。
 */
import { sendPush, bytesToB64u } from "./push.js";

/* ---------- 工具 ---------- */
const json = (data, status, env) =>
  new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors(env) }
  });

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

async function subIdFor(endpoint) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return bytesToB64u(hash).slice(0, 22);
}

/* ---------- API ---------- */
async function handleSubscribe(req, env) {
  const { subscription } = await req.json();
  const ep = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!ep || !p256dh || !auth) return json({ error: "订阅信息不完整" }, 400, env);

  const id = await subIdFor(ep);
  await env.DB.prepare(
    `INSERT INTO subs (id, endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,
       p256dh=excluded.p256dh, auth=excluded.auth`
  ).bind(id, ep, p256dh, auth, Date.now()).run();

  return json({ subId: id }, 200, env);
}

async function handleSync(req, env) {
  const { subId, items } = await req.json();
  if (!subId || !Array.isArray(items)) return json({ error: "参数不合法" }, 400, env);

  const sub = await env.DB.prepare("SELECT id FROM subs WHERE id = ?").bind(subId).first();
  if (!sub) return json({ error: "订阅不存在，请重新连接" }, 404, env);

  const stmts = [
    // 只清掉「还没推送过」的，已推送记录保留，避免重复提醒
    env.DB.prepare("DELETE FROM reminders WHERE sub_id = ? AND sent = 0").bind(subId)
  ];
  for (const it of items.slice(0, 500)) {
    if (!it || !it.id || !it.text || !it.at) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO reminders (id, sub_id, text, at, note, sent)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).bind(it.id, subId, String(it.text).slice(0, 300), it.at,
             it.note ? String(it.note).slice(0, 120) : null)
    );
  }
  await env.DB.batch(stmts);

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM reminders WHERE sub_id = ? AND sent = 0"
  ).bind(subId).first();
  return json({ ok: true, pending: row?.n ?? 0 }, 200, env);
}

async function handleAck(req, env) {
  const { subId, id } = await req.json();
  if (!subId || !id) return json({ error: "参数不合法" }, 400, env);
  // 置为一个大值，后续重复提醒全部跳过
  await env.DB.prepare(
    "UPDATE reminders SET sent = 999 WHERE sub_id = ? AND id = ?"
  ).bind(subId, id).run();
  return json({ ok: true }, 200, env);
}

async function handleTest(req, env) {
  const { subId } = await req.json();
  const sub = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth FROM subs WHERE id = ?"
  ).bind(subId).first();
  if (!sub) return json({ error: "订阅不存在" }, 404, env);

  const r = await sendPush(sub, {
    title: "⏰ 轻提醒",
    body: "推送已接通，到点会这样叫你 🎉",
    id: "test"
  }, env);

  if (r.gone) await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(subId).run();
  return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502, env);
}

/* ---------- 定时扫描 ---------- */
async function runDue(env) {
  // 一条提醒最多推几次（每次间隔 1 分钟，点开后停止）
  const REPEAT = Math.max(1, parseInt(env.REPEAT_TIMES || "3", 10));
  // 提前 20 秒取，抵消每分钟一次的调度粒度
  const now = Date.now() + 20000;
  // 10 分钟前就该发的不再补发，避免服务中断后一次性轰炸
  const floor = Date.now() - 10 * 60000;

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.sub_id, r.text, r.at, r.note, r.sent,
            s.endpoint, s.p256dh, s.auth
       FROM reminders r JOIN subs s ON s.id = r.sub_id
      WHERE r.sent < ? AND r.at <= ? AND r.at > ?
      ORDER BY r.at LIMIT 100`
  ).bind(REPEAT, now, floor).all();

  if (!results?.length) return { sent: 0 };

  let sent = 0;
  for (const row of results) {
    const times = (row.sent || 0) + 1;
    const finished = times >= REPEAT;
    // 先落库，避免下一分钟重复推送；没推满就顺延 1 分钟再推一次
    await env.DB.prepare(
      "UPDATE reminders SET sent = ?, at = ? WHERE sub_id = ? AND id = ?"
    ).bind(times, finished ? row.at : row.at + 60000, row.sub_id, row.id).run();

    // note 由前端按本机时区预先格式化好，服务端不做时间换算，避免时区错位
    let body = row.note ? `${row.text}（${row.note}）` : row.text;
    if (times > 1) body += ` · 第 ${times} 次提醒`;

    try {
      const r = await sendPush(row, {
        title: "⏰ 轻提醒", body, id: row.id, subId: row.sub_id
      }, env);
      if (r.ok) sent++;
      if (r.gone) {
        await env.DB.prepare("DELETE FROM subs WHERE id = ?").bind(row.sub_id).run();
        await env.DB.prepare("DELETE FROM reminders WHERE sub_id = ?").bind(row.sub_id).run();
      }
    } catch (e) {
      // 单条失败不影响其它提醒
    }
  }
  return { sent, scanned: results.length };
}

/* ---------- 入口 ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env) });

    try {
      if (url.pathname === "/api/vapid" && req.method === "GET")
        return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, env);

      if (url.pathname === "/api/subscribe" && req.method === "POST")
        return await handleSubscribe(req, env);

      if (url.pathname === "/api/sync" && req.method === "POST")
        return await handleSync(req, env);

      if (url.pathname === "/api/test" && req.method === "POST")
        return await handleTest(req, env);

      if (url.pathname === "/api/ack" && req.method === "POST")
        return await handleAck(req, env);

      if (url.pathname === "/api/health")
        return json({ ok: true, time: Date.now() }, 200, env);

      // 手动触发一次扫描，便于排查
      if (url.pathname === "/api/run" && req.method === "POST")
        return json(await runDue(env), 200, env);

      return json({ error: "未找到该接口" }, 404, env);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, env);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDue(env));
  }
};
