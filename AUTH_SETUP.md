# 学校邮箱验证码：Gmail 免费发信配置

首选方案为 **Gmail + Google Apps Script**：网站服务端通过 HTTPS 请求 Google 托管的程序，由维护者授权的 Gmail 向学校邮箱发验证码，不需要购买发件域名或租用服务器。学生仍使用学校邮箱验证码登录，**不是 Google 账号登录**。免费额度适合小规模试用，不保证无限量或固定可用性。

代码接入、Google 授权、Web 应用部署、Sites 环境启用、实际收件和生产登录分别验收；代码准备完成不表示已经开通，实际状态见 [QA.md](QA.md)。QQ 本地发信保留为备选。用户已选择暂不产生费用，Render 仅保留部署包，未创建收费资源。

本站只有“学校邮箱验证码登录”和“访客浏览”。收件域严格为 `student.xjtlu.edu.cn`；验证只证明邮箱控制权，**不代表核实当前在读学籍、校方背书或实际校区**。访客只读公开商品，发布、收藏和卖家联系方式需要学校邮箱会话。未配置时明确显示不可发送，不提供假验证码或模拟账号。

每次验证码登录成功，昵称按此次输入邮箱前缀移除 ASCII 数字 `0..9`，保留大小写、最多 20 个字符，空结果使用“橘子同学”。下次验证码登录会覆盖手动昵称。派生昵称可能包含姓名并预填新商品表单，发布前可以修改；既有商品不会批量改名。

## 1. 准备私有配置

需要 Node.js 22.13+，在仓库根目录运行：

```powershell
npm ci
npm run mail:gmail:setup -- 你的Gmail地址
```

将占位符替换为自己的 Gmail。此命令只准备被 Git 忽略的 `gmail-apps-script/.env.local`，保存发件账号、高熵共享密钥和脚本额度，初始 `ENABLED=false`。默认不改动根 `.env.local`，不影响已有 QQ 本地配置；不发邮件、不创建 Google 部署或代替账号授权。不要把生成的秘密值粘贴到聊天、Issue、截图或公开代码。

## 2. 创建 Google 托管的发信程序

1. 用作发件人的 Gmail 账号打开 [Google Apps Script](https://script.google.com/home)，新建独立项目。发件人由部署并授权脚本的 Google 账号决定，不能通过填写任意邮箱冒用发件人。
2. 将 [gmail-apps-script/Code.js](gmail-apps-script/Code.js) 的完整内容复制到 `Code.gs`。在项目设置中显示清单，将 [gmail-apps-script/appsscript.json](gmail-apps-script/appsscript.json) 复制为 `appsscript.json`，保存。
3. 在“项目设置 → 脚本属性”私下配置下表。属性可被项目编辑者访问，仅向必要维护者授予编辑权限。
4. 部署为 **Web 应用**，执行身份选“我”，访问权限选“任何人”，由账号本人审阅并完成 Google 发信授权。页面名称以当前界面为准；账号验证或未验证应用提示由本人处理。
5. 保存正式 `https://script.google.com/macros/s/<部署ID>/exec` 地址。`/dev` 只供编辑者测试，不能填入 Sites。

| Script Property | 设置 |
| --- | --- |
| `JUZI_GMAIL_SCRIPT_SECRET` | 本地准备文件中的至少 32 字符高熵共享密钥，与网站同名服务端秘密值一致；不要复用网站验证码 HMAC 密钥 |
| `ENABLED` | 初始 `false`，准备完成并获准发送后改为 `true` |
| `JUZI_GMAIL_DAILY_LIMIT` | 默认 `50`，允许 `1..100`；预留后失败或不确定的请求也计数 |

清单只请求 `https://www.googleapis.com/auth/script.send_mail`。本实现用 **MailApp** 发信，不请求读取 Gmail 收件箱的权限，也不需要 Gmail SMTP 授权码。[MailApp 官方说明](https://developers.google.com/apps-script/reference/mail/mail-app)、[部署与执行身份](https://developers.google.com/apps-script/guides/web)

普通 Gmail 当前 Apps Script 邮件额度为每天 **100 个收件人**，按用户计算，首次请求后 24 小时重置；额度可能调整，也会受同账号其他脚本影响。本站默认 50 次/滚动 24 小时，另检查 Google 剩余额度；还受执行、并发和存储限制。公开端点即使拒绝无效签名，也可能消耗执行资源。[Google 官方额度](https://developers.google.com/apps-script/guides/services/quotas)

## 3. 配置网站服务端

正式脚本部署完成后，可把 URL 保存进私有准备文件：

```powershell
npm run mail:gmail:setup -- 你的Gmail地址 --url https://script.google.com/macros/s/实际部署ID/exec
```

Sites 生产配置通过平台原生环境设置注入；本地使用忽略的根 `.env.local`。不要上传环境文件，也不要给秘密值加 `VITE_` 或 `NEXT_PUBLIC_` 前缀。

| 网站服务端变量 | 设置 |
| --- | --- |
| `JUZI_EMAIL_PROVIDER` | `gmail_apps_script` |
| `JUZI_GMAIL_SCRIPT_URL` | 正式部署的精确 HTTPS `/exec` 地址，无查询、片段或用户信息 |
| `JUZI_GMAIL_SCRIPT_SECRET` | 与 Script Properties 相同，作为服务端秘密值保存 |
| `JUZI_EMAIL_AUTH_SECRET` | 独立的至少 32 字符高熵验证码 HMAC 密钥，保留已有有效值，不为切换服务无故轮换 |
| `JUZI_EMAIL_ORIGIN` | 本地 `http://localhost:4174`；生产 `https://juzi-campus-market.open-bloom-6517.chatgpt.site`，均无末尾斜线 |
| `JUZI_EMAIL_DAILY_LIMIT` | 建议明确设为 `50`，与脚本额度同时生效 |
| `JUZI_EMAIL_ENABLED` | 准备与授权完成前 `false`，开通并进行实际验收时设为 `true` |

学校邮箱是**收件人**，维护者 Gmail 是**发件人**，不冒充学校。网站向脚本发送带时间戳、请求 ID 和 HMAC 签名的 JSON，密钥不提供给浏览器。Apps Script 事件不提供任意 HTTP 鉴权头，因此这里不依赖 Bearer 头。

脚本只接受学校域、6 位验证码和固定邮件内容，不是任意邮件转发器。发送前在 Script Properties 持久预留，用脚本锁防并发重复；仅保存请求标识、摘要、时间和状态，不保存完整收件地址或验证码。同一成功请求返回原确认，失败或不确定请求不自动重发，不要清空账本绕过额度。Google 的 Content Service 会重定向响应，适配器仅在允许的 Google 域读取结果，不再转发原邮件正文。[重定向说明](https://developers.google.com/apps-script/guides/content#redirects)

## 4. 本地启动与实际验收

脚本已授权、正式 URL 可用且两侧属性匹配后，启用本地入口：

```powershell
npm run mail:gmail:setup -- 你的Gmail地址 --enable
npm run build
npm run dev
```

`--enable` 只核对私有配置并选择本地 Gmail 服务商，保留已有网站 HMAC 密钥及备选配置；它不验证实际 Google 授权或邮件送达。打开 <http://localhost:4174/#/login>，地址必须与 Origin 一致，不要改用 `127.0.0.1`。Gmail 路径调用远程 HTTPS，无需启动 QQ 中继。启动先应用本地迁移，本身不发邮件；改配置后停止对应旧服务再重启，避免端口冲突。

用自己控制的学校邮箱申请一封验证码，确认学校收件箱收到，再在发起请求的同一浏览器填码。确认个人中心显示“学校邮箱已验证”、昵称正确、刷新会话保持，退出后访客不能发布、收藏或读取联系方式。发送成功仅代表 Google 接受邮件，不能代替实际送达；超时后不要盲目自动重发。

生产另行发布应用、设置平台秘密值，分别验证公开访问、学校收件与生产会话。Cloudflare 拦截与邮件配置是不同环节，部署成功或本地成功都不能证明公网已可访问。实际结果记录在 [QA.md](QA.md)，不能把 mock 传输测试写成真实发信。

验证码 10 分钟有效，每挑战最多 5 次尝试，绑定浏览器且一次使用。发送失败也计数：同邮箱至少间隔 60 秒、最多 10 次/滚动 24 小时；同浏览器最多 20 次。会话固定 7 天，Cookie 使用 `HttpOnly`、`SameSite=Lax`，生产另有 `Secure`。浏览器绑定 Cookie 保留 24 小时，退出或访客不清除此非登录限流标识。字段与保留限制见 [PRIVACY.md](PRIVACY.md)。

## 5. 更新、停用与密钥轮换

修改脚本后，在“管理部署”中为现有部署选择新版本并保存；只保存编辑器不会更新正式 `/exec`。记录代码提交和部署版本，回退时选择先前兼容版本。Script Properties 是项目共享配置，回退代码不会回退密钥、额度或账本，不要删除账本作为回退手段。

停用时先设网站 `JUZI_EMAIL_ENABLED=false`，再设脚本 `ENABLED=false`，必要时停用 Google 部署或撤销授权。轮换共享密钥时先停发，生成新值并更新脚本和 Sites 两侧，发布/重启运行时后再启用和验收。不要轮换无关的 `JUZI_EMAIL_AUTH_SECRET`；它用于网站验证码校验，变更会使尚未使用的验证码失效。

## 6. QQ 本地与 Resend 备选

QQ 本地链路曾完成真实收件与登录，不代表 Gmail 或生产已验收。切回 QQ 前先停止当前服务并保留原配置：

```powershell
npm --prefix relay ci
npm run mail:setup -- 你的QQ邮箱
```

将占位符替换为自己的完整数字 QQ 邮箱。脚本选择 `qq_relay` 并保持发信关闭，配对根 `.env.local` 与 `relay/.env.local` 令牌、复用有效网站密钥；遇 `.dev.vars` 覆盖或令牌冲突会拒绝改写。该命令会切换本地服务商，避免无意覆盖 Gmail 选择。

本人在 QQ 安全设置开启 SMTP、生成客户端授权码，私下填写 `relay/.env.local` 的 `QQ_SMTP_AUTH_CODE`，不要使用 QQ 登录密码或发到聊天。运行 `npm run mail:setup -- --enable` 仅检查格式并启用，不验证凭据或发信。之后 `npm run dev` 自动启动网站和中继，或分开运行 `npm run mail:relay`、`npm run dev:site`。[腾讯配置说明](https://cloud.tencent.com/document/product/1207/45117)

中继固定连接 `smtp.qq.com:465` 并校验证书，默认监听 `127.0.0.1:4180`；网站使用 `JUZI_EMAIL_RELAY_URL=http://127.0.0.1:4180/send` 和 `JUZI_EMAIL_RELAY_TOKEN`，中继使用匹配的 `JUZI_RELAY_TOKEN`、`QQ_SMTP_USER`、`QQ_SMTP_AUTH_CODE`，QQ 凭据不进入 Worker。忽略目录 `relay/.state/` 保存 SQLite 账本，默认 50 次/滚动 24 小时，失败和不确定请求计数，重启不重置。本地回环服务不会自动公开上线。

仓库保留 `render.yaml` 和 QQ 生产部署包，**用户已决定暂不产生费用，未创建 Render 收费资源**；Gmail 路径不依赖它。详见 [DEPLOYMENT.md](DEPLOYMENT.md)。

若以后使用 Resend，需维护者自有且已验证的发件域名，配置 `JUZI_EMAIL_PROVIDER=resend`、`JUZI_EMAIL_FROM` 和服务端秘密值 `RESEND_API_KEY`。学校收件域和 Sites 域不能冒用；Gmail 路径不需要这项域名验证。[Resend 发件域](https://resend.com/docs/dashboard/domains/introduction)、[发送接口](https://resend.com/docs/api-reference/emails/send-email)
