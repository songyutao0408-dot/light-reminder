/** 生成 VAPID 密钥对：公钥填进 wrangler.toml，私钥作为 Worker secret */
const kp = await crypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
);
const b64u = (b) => Buffer.from(b).toString("base64url");
const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);

console.log("\n=== VAPID 公钥（填入 wrangler.toml 的 VAPID_PUBLIC_KEY）===");
console.log(pub);
console.log("\n=== VAPID 私钥 JWK（作为 secret VAPID_PRIVATE_JWK，切勿公开）===");
console.log(JSON.stringify(jwk));
console.log("");
