# 部署推送后端（约 10 分钟，全程免费）

部署完成后：**加完提醒就不用管了，到点手机自己响 —— 锁屏、App 关掉都收得到。**

用的是 Cloudflare Workers 免费额度（每天 10 万次请求 + 定时任务），个人用完全够，不需要绑卡。

---

## 开始之前

- 一台电脑（下面以 Windows 为例，Mac 同理）
- 一个 [Cloudflare 账号](https://dash.cloudflare.com/sign-up)（免费注册，不用绑卡）

---

## 第 1 步：装 Node.js

去 https://nodejs.org 下载 **LTS** 版本，双击安装，一路点「Next / 下一步」到底即可。

## 第 2 步：下载代码

点这个链接直接下载压缩包：
https://github.com/songyutao0408-dot/light-reminder/archive/refs/heads/main.zip

下载后**解压到桌面**，会得到一个 `light-reminder-main` 文件夹。（不需要安装 Git）

## 第 3 步：打开终端

按 `Win + R`，输入 `cmd`，回车 —— 打开「命令提示符」。

> 💡 也可以在开始菜单搜「Node.js command prompt」，效果一样。
> 若用 PowerShell 报 `0x800704EC`（被组策略禁用），就改用上面的 cmd。

先把目录切到代码里（整行复制粘贴，回车）：

```bat
cd /d "%USERPROFILE%\Desktop\light-reminder-main\server"
```

如果提示找不到路径，多半是桌面被 OneDrive 接管了，改用这条：

```bat
cd /d "%USERPROFILE%\OneDrive\Desktop\light-reminder-main\server"
```

> 还是不行的话：打开那个 `server` 文件夹，点一下上方地址栏复制完整路径，
> 用 `cd /d "粘贴的路径"` 代替。

顺便确认 Node 版本（需要 v20 或更高）：

```bat
node -v
```

## 第 4 步：安装依赖

```powershell
npm install
```

## 第 5 步：一键部署

```powershell
npm run setup
```

### 如果报 `spawn UNKNOWN` / 浏览器不弹授权

公司电脑常见：系统策略不让 wrangler 拉起浏览器，OAuth 登录走不通。
改用 **API Token**（同样免费，一次性）：

1. 打开 https://dash.cloudflare.com/profile/api-tokens
   → **Create Token** → 最下面的 **Custom token** → **Get started**
2. 权限（Permissions）加三行：

   | | | |
   |---|---|---|
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |
   | Account | Account Settings | Read |

3. **Account Resources** 选 `Include | 你的账号`
4. 底部 **Continue to summary** → **Create Token** → **复制那串 Token**（只显示一次）
5. 回到 cmd 窗口执行（`=` 两边不要有空格）：

```bat
set CLOUDFLARE_API_TOKEN=把你复制的Token粘贴到这里
```

6. 再跑一次：

```bat
npm run setup
```

> `set` 只对当前窗口有效。若关掉窗口重来，需要重新执行一次第 5 条。

这一条命令会自动完成：登录 Cloudflare、建数据库、生成推送密钥、建表、部署上线。
中途会：

- **弹出浏览器让你授权** → 点 **Allow**
- 若问 `Ok to proceed? (y)` → 输入 `y` 回车

跑完会打印你的后端地址，形如：

```
https://light-reminder-push.你的用户名.workers.dev
```

**把它复制下来。**

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
