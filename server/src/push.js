/**
 * Web Push 发送实现（RFC 8291 aes128gcm + RFC 8292 VAPID）
 *
 * 纯 WebCrypto，无任何依赖，可直接跑在 Cloudflare Workers 上。
 * 特意不用现成库：常见的 webpush-webcrypto 只实现了旧版 aesgcm，
 * 而 Apple / iOS 只接受 aes128gcm，用错会静默推送失败。
 */

const enc = new TextEncoder();

/* ---------- base64url ---------- */
export function b64uToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64u(buf) {
  const arr = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- HKDF（WebCrypto 一步完成 Extract+Expand） ---------- */
async function hkdf(ikm, salt, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8
  );
  return new Uint8Array(bits);
}

/**
 * 按 RFC 8291 加密推送负载
 * @returns {Uint8Array} aes128gcm 消息体
 */
export async function encryptPayload(plaintextStr, p256dhB64u, authB64u) {
  const uaPublicRaw = b64uToBytes(p256dhB64u);   // 65 字节未压缩点
  const authSecret = b64uToBytes(authB64u);      // 16 字节
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 应用服务器临时 ECDH 密钥对
  const asKeys = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));

  const uaPublicKey = await crypto.subtle.importKey(
    "raw", uaPublicRaw, { name: "ECDH", namedCurve: "P-256" }, false, []
  );
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey }, asKeys.privateKey, 256
  ));

  // IKM = HKDF(ecdh, salt=auth_secret, info="WebPush: info"||0x00||ua_pub||as_pub)
  const keyInfo = concat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPublicRaw, asPublicRaw);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const cek = await hkdf(ikm, salt, concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 16);
  const nonce = await hkdf(ikm, salt, concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])), 12);

  // 明文尾部追加 0x02 分隔符（最后一个记录）
  const padded = concat(enc.encode(plaintextStr), new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, padded
  ));

  // 头部：salt(16) | rs(4) | idlen(1) | as_public(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  return concat(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw, ciphertext);
}

/* ---------- VAPID（RFC 8292，ES256 JWT） ---------- */
export async function buildVapidAuth(endpoint, privateJwk, publicKeyB64u, contact) {
  const aud = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: contact || "mailto:noreply@example.com"
  };
  const signingInput =
    bytesToB64u(enc.encode(JSON.stringify(header))) + "." +
    bytesToB64u(enc.encode(JSON.stringify(payload)));

  const key = await crypto.subtle.importKey(
    "jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput)
  );
  const jwt = signingInput + "." + bytesToB64u(sig);
  return `vapid t=${jwt}, k=${publicKeyB64u}`;
}

/**
 * 向单个订阅发送一条推送
 * @returns {Promise<{ok:boolean,status:number,gone:boolean}>}
 */
export async function sendPush(sub, payloadObj, env) {
  const body = await encryptPayload(JSON.stringify(payloadObj), sub.p256dh, sub.auth);
  const auth = await buildVapidAuth(
    sub.endpoint,
    JSON.parse(env.VAPID_PRIVATE_JWK),
    env.VAPID_PUBLIC_KEY,
    env.VAPID_CONTACT
  );

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Authorization": auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Urgency": "high"
    },
    body
  });

  // 404/410 表示订阅已失效，应当清理
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
