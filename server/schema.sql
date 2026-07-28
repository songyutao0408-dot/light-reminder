-- 轻提醒 · 推送后端数据表

CREATE TABLE IF NOT EXISTS subs (
  id       TEXT PRIMARY KEY,          -- endpoint 的 SHA-256 前缀，稳定不变
  endpoint TEXT NOT NULL UNIQUE,      -- 浏览器推送端点（APNs / FCM）
  p256dh   TEXT NOT NULL,             -- 订阅公钥
  auth     TEXT NOT NULL,             -- 订阅认证密钥
  created  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reminders (
  id      TEXT NOT NULL,              -- 与前端 localStorage 中的 id 一致
  sub_id  TEXT NOT NULL,
  text    TEXT NOT NULL,              -- 提醒内容
  at      INTEGER NOT NULL,           -- 何时推送（epoch 毫秒）
  note    TEXT,                       -- 前端按本机时区预格式化的补充说明
  sent    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sub_id, id)
);

-- 定时任务按「未发送 + 到期时间」扫描
CREATE INDEX IF NOT EXISTS idx_due ON reminders (sent, at);
