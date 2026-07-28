# 部署推送后端（约 10 分钟，全程免费）

部署完成后：**加完提醒就不用管了，到点手机自己响 —— 锁屏、App 关掉都收得到。**

用的是 Cloudflare Workers 免费额度（每天 10 万次请求 + 定时任务），个人用完全够，不需要绑卡。

---

## 开始之前

需要一台**电脑**（Windows / Mac 都行），装好 [Node.js](https://nodejs.org)（LTS 版即可）。
在终端里确认能跑：

```bash
node -v      # 显示 v20 或更高就行
```

还需要一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费注册，邮箱即可）。

---

## 第 1 步：拿到代码

```bash
git clone https://github.com/songyutao0408-dot/light-reminder.git
cd light-reminder/server
npm install
```

## 第 2 步：登录 Cloudflare

```bash
npx wrangler login
```

会自动打开浏览器让你授权，点 **Allow** 即可。

## 第 3 步：创建数据库

```bash
npx wrangler d1 create light-reminder
```

命令会输出一段配置，形如：

```
[[d1_databases]]
binding = "DB"
database_name = "light-reminder"
database_id = "abcd1234-..."      ← 把这一串复制下来
```

打开 `wrangler.toml`，把最底下的 `database_id = "PLACEHOLDER_RUN_SETUP"`
替换成你刚拿到的那串 id。

然后建表：

```bash
npx wrangler d1 execute light-reminder --remote --file=schema.sql
```

## 第 4 步：生成推送密钥

```bash
npm run gen-vapid
```

会打印两段内容：

- **VAPID 公钥**：打开 `wrangler.toml`，填到 `VAPID_PUBLIC_KEY = ""` 的引号里
- **VAPID 私钥 JWK**：执行下面命令，把那一整行 JSON 粘进去回车

```bash
npx wrangler secret put VAPID_PRIVATE_JWK
```

> 私钥是机密，只存在 Cloudflare，不要提交到 Git、不要发给任何人。

顺便把 `wrangler.toml` 里的 `VAPID_CONTACT` 改成你的邮箱
（推送服务商用来在出问题时联系你，随便填一个能收信的即可）。

## 第 5 步：部署

```bash
npx wrangler deploy
```

成功后会输出你的后端地址，形如：

```
https://light-reminder-push.<你的用户名>.workers.dev
```

**把这个地址复制下来。**

---

## 第 6 步：在手机上连接

1. iPhone 用 **Safari** 打开 App 网址，先「分享 → 添加到主屏幕」；
   之后**必须从桌面图标打开**（iOS 只允许已安装的 PWA 接收推送）。
2. 打开 App，点顶部「**云端推送 · 未开启**」那一行右侧的「设置」。
3. 把第 5 步的地址粘进输入框，点「**连接**」。
4. 系统弹窗问是否允许通知 → 点「**允许**」。
5. 显示「✅ 已开启」后，点「**发送测试推送**」。
6. **锁屏**，一两秒内应该会收到一条通知。收到就成了 🎉

之后你加的每条提醒都会自动同步到后端，到点由服务器推给你。

---

## 常见问题

**点「连接」报「拿不到服务器公钥」**
后端地址填错，或第 4 步的公钥没填进 `wrangler.toml`（填完要重新 `npx wrangler deploy`）。

**报「iPhone 请先添加到主屏幕」**
你是在 Safari 标签页里打开的。必须先加到主屏幕，再从桌面图标进入。

**测试推送成功，但到点没收到**
定时任务每分钟跑一次，提醒可能晚最多 1 分钟属正常。
若完全没有，看后端日志：`npx wrangler tail`

**通知不响只有横幅**
检查手机是否处于静音/专注模式；iOS 设置 → 通知 → 轻提醒，把「声音」打开。

**改了 `wrangler.toml` 之后**
任何改动都要重新 `npx wrangler deploy` 才生效。

---

## 费用

Cloudflare Workers 免费额度：每天 10 万次请求、定时任务免费、D1 数据库 5GB。
个人用提醒 App 连零头都用不到，**不会产生费用**，也不需要绑定信用卡。
