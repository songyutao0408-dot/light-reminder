/* 轻提醒 Service Worker
 * 策略：网络优先（network-first）——联网时永远拿最新版本，断网才用缓存兜底。
 * 之前用缓存优先会把旧页面焊死、新版本推不下去，已改。
 */
const CACHE = "light-reminder-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-180.png"
];

self.addEventListener("install", (e) => {
  // 新版本立刻就位，不等旧页面全部关闭
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type: "window" }))
      .then((clients) => {
        // 旧页面自身没有自动更新逻辑，这里主动把它们刷成新版
        clients.forEach((c) => { if (c.navigate) c.navigate(c.url).catch(() => {}); });
      })
      .catch(() => {})
  );
});

self.addEventListener("message", (e) => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

/* ---------- 推送：App 关闭 / 锁屏时由服务器触发 ---------- */
self.addEventListener("push", (e) => {
  let data = { title: "⏰ 轻提醒", body: "有一条提醒到点了" };
  try {
    if (e.data) {
      const d = e.data.json();
      data = { title: d.title || data.title, body: d.body || data.body, id: d.id };
    }
  } catch (err) {
    try { data.body = e.data.text(); } catch (e2) {}
  }

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: data.id || "reminder",
      renotify: true,
      requireInteraction: true,
      vibrate: [200, 100, 200, 100, 200],
      data: { id: data.id }
    })
  );
});

// 读取页面写入的后端配置（SW 访问不到 localStorage）
async function pushCfg() {
  try {
    const c = await caches.open("lr-config");
    const r = await c.match("/__push_cfg");
    return r ? await r.json() : null;
  } catch (e) { return null; }
}

// 告诉服务器「我看到了」，后续的重复提醒不用再发
async function ackReminder(id) {
  if (!id || id === "test") return;
  const cfg = await pushCfg();
  if (!cfg || !cfg.api || !cfg.subId) return;
  try {
    await fetch(cfg.api + "/api/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subId: cfg.subId, id })
    });
  } catch (e) {}
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(Promise.all([
    ackReminder(id),
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  ]));
});

// 直接划掉通知也算看到了
self.addEventListener("notificationclose", (e) => {
  const id = e.notification.data && e.notification.data.id;
  e.waitUntil(ackReminder(id));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域交给浏览器自己处理

  // 网络优先：拿到新的就用新的并回写缓存；断网/失败才回退缓存
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          // 导航请求兜底到首页，保证离线也能打开 App
          if (req.mode === "navigate") return caches.match("./index.html");
          return Response.error();
        })
      )
  );
});
