/**
 * 验证 push.js 的加密与签名是否符合规范：
 * 1) aes128gcm 往返：用订阅方私钥解密，还原明文即为正确
 * 2) VAPID JWT：用公钥验签，并检查 aud/exp/sub
 */
import { encryptPayload, buildVapidAuth, b64uToBytes, bytesToB64u } from "../src/push.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✅", m); } else { fail++; console.log("  ❌", m); } };

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(ikm, salt, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/* ---------- 1. aes128gcm 往返 ---------- */
console.log("\n[1] aes128gcm 加解密往返");
{
  // 模拟浏览器订阅端的密钥
  const uaKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeys.publicKey));
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  const message = JSON.stringify({ title: "⏰ 轻提醒", body: "11:05 开会（提前2分钟）", id: "r123" });
  const packet = await encryptPayload(message, bytesToB64u(uaPublicRaw), bytesToB64u(authSecret));

  // --- 以下完全站在「客户端」角度解密 ---
  const salt = packet.slice(0, 16);
  const rs = new DataView(packet.buffer, packet.byteOffset + 16, 4).getUint32(0, false);
  const idlen = packet[20];
  const asPublicRaw = packet.slice(21, 21 + idlen);
  const ciphertext = packet.slice(21 + idlen);

  ok(idlen === 65, `as_public 长度为 65（实际 ${idlen}）`);
  ok(rs === 4096, `record size 为 4096（实际 ${rs}）`);

  const asPublicKey = await crypto.subtle.importKey("raw", asPublicRaw,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: asPublicKey }, uaKeys.privateKey, 256));

  const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);
  const cek = await hkdf(ikm, salt, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plainPadded = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, ciphertext));

  ok(plainPadded[plainPadded.length - 1] === 2, "末尾为 0x02 记录分隔符");
  const recovered = dec.decode(plainPadded.slice(0, -1));
  ok(recovered === message, "解密结果与原文完全一致");
  if (recovered !== message) console.log("     期望:", message, "\n     实际:", recovered);
}

/* ---------- 2. VAPID JWT 验签 ---------- */
console.log("\n[2] VAPID JWT（ES256）");
{
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const endpoint = "https://web.push.apple.com/abcdef123456";

  const header = await buildVapidAuth(endpoint, privJwk, bytesToB64u(pubRaw), "mailto:me@example.com");
  ok(header.startsWith("vapid t="), "Authorization 以 'vapid t=' 开头");
  ok(header.includes(", k=" + bytesToB64u(pubRaw)), "带上了 k=<公钥>");

  const jwt = header.slice("vapid t=".length, header.indexOf(", k="));
  const [h, p, s] = jwt.split(".");
  const claims = JSON.parse(new TextDecoder().decode(b64uToBytes(p)));
  ok(JSON.parse(new TextDecoder().decode(b64uToBytes(h))).alg === "ES256", "alg 为 ES256");
  ok(claims.aud === "https://web.push.apple.com", `aud 为 endpoint 的 origin（${claims.aud}）`);
  ok(claims.sub === "mailto:me@example.com", "sub 为联系方式");
  const hours = (claims.exp - Math.floor(Date.now() / 1000)) / 3600;
  ok(hours > 11 && hours <= 12.1, `exp 在 12 小时内（${hours.toFixed(1)}h，规范要求 ≤24h）`);

  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" },
    kp.publicKey, b64uToBytes(s), enc.encode(h + "." + p));
  ok(valid, "签名可用公钥验证通过");
  ok(b64uToBytes(s).length === 64, "签名为 64 字节 raw(r||s) 格式（非 DER）");
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
