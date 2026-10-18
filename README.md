# 橘子集 · 西交利物浦大学校园二手交易平台

面向西交利物浦大学的 SIP 校区与太仓校区，交易类别为小电器、电瓶车和生活用品。保留原生 HTML/CSS/JavaScript 界面，使用 Sites 官方 Vinext 后端、D1 数据库和 R2 图片存储。首页、商品详情、发布与个人中心均适配桌面和手机。

本站提供**学校邮箱验证码登录**和**访客浏览**。访客可搜索、筛选和查看公开商品；发布、收藏、卖家联系方式和个人记录需要学校邮箱认证。验证码证明控制 `@student.xjtlu.edu.cn` 邮箱，**不代表核实当前在读学籍或所在校区**。账号昵称按邮箱前缀去数字生成，商品卖家昵称可在发布前编辑；完整登录邮箱不作为公开卖家资料。具体字段和下架效果见 [PRIVACY.md](PRIVACY.md)。

交易仍通过卖家联系方式沟通和线下面交完成；当前没有站内私信、订单或支付功能。

## 本地启动

需要 **Node.js 22.13.0 或更高版本**及 npm。从仓库根目录运行：

```powershell
npm ci
npm run build
npm run dev
```

本地统一打开 <http://localhost:4174/>。`npm run dev` 启动前自动应用本地数据库迁移；首次启动仍须先构建，以生成迁移使用的配置。已启用并配置好 QQ 本地发信时，它会在同一个终端启动邮件中继与网站，按 `Ctrl+C` 停止本次启动的子进程；启动本身不会发送邮件。默认端口取自精确的 `JUZI_EMAIL_ORIGIN`，本项目使用 `http://localhost:4174`，没有配置时默认 4174。

若中继已在另一终端运行，用 `npm run dev:site` 只启动网站；需要手动迁移时仍可运行 `npm run db:migrate`。这些迁移只操作本地模拟数据库，正式迁移由 Sites 发布流程应用。特殊环境配置可直接运行 `node scripts/run-framework.mjs dev --port 4174`，自行负责迁移、中继及 Origin 一致性。

首选公网发信为 **Gmail + Google Apps Script**，无需购买发件域名或租用服务器。维护者授权的 Gmail 发验证码，学生仍使用学校邮箱验证码登录，不需要 Google 账号。新环境邮箱登录默认关闭，可以先用访客浏览。准备私有配置：

```powershell
npm run mail:gmail:setup -- 你的Gmail地址
```

此命令仅准备忽略的 `gmail-apps-script/.env.local`，生成共享密钥和默认 50 次/滚动 24 小时额度；默认保留已有根配置，不发邮件或代替 Google 授权。将 `gmail-apps-script/Code.js` 和清单复制到自己 Google 账号的 Apps Script，配置私有 Script Properties，完成发信授权并部署正式 Web 应用后，再保存地址和启用本地入口：

```powershell
npm run mail:gmail:setup -- 你的Gmail地址 --url https://script.google.com/macros/s/实际部署ID/exec
npm run mail:gmail:setup -- 你的Gmail地址 --enable
npm run dev
```

`--enable` 只启用本地配置，不能证明 Google 授权或送达；仍需自己控制的学校邮箱实际收码并登录。访问 <http://localhost:4174/#/login>，Origin 保持一致；Gmail 路径不启动 QQ 中继。MailApp 仅请求发信权限，不读取 Gmail 收件箱。普通 Gmail 当前 Google 额度为每日 100 个收件人，本站默认限 50 次，适合小规模试用。[MailApp](https://developers.google.com/apps-script/reference/mail/mail-app)、[Google 额度](https://developers.google.com/apps-script/guides/services/quotas)

完整授权、部署、私密环境设置、停用与轮换步骤见 [AUTH_SETUP.md](AUTH_SETUP.md)，公开格式参考见 [.env.example](.env.example)。QQ 本地 SMTP 和 Resend 保留备选；用户已决定暂不产生费用，Render 仅保留 QQ 部署包，未创建收费服务。真实地址与密钥不提交 Git、不发到聊天。学校邮箱是收件人，个人 Gmail 或 QQ 是发件人，不冒充校方。

本地开发也必须通过邮箱验证码取得交易权限，不提供模拟业务账号。宿主平台的登录状态不授予本应用权限。选择访客或退出会清除本站会话；历史商品与收藏保留，不会自动合并到新邮箱账号。

## 账号与日常使用

每次邮箱验证码验证成功后，账号昵称更新为此次输入邮箱 `@` 前的部分去掉数字 `0..9`，保留大小写，最多 20 个字符；空结果使用“橘子同学”。登录后可以在个人中心修改昵称和常用校区，手动昵称在下次验证码登录时会再次按邮箱生成。它们预填之后新建的商品表单，不改写已有商品的卖家昵称或校区。

邮箱派生昵称可能包含姓名。发布表单可以另填愿意公开的卖家昵称，确认发布后对访客公开；交易联系方式仍仅向学校邮箱登录用户提供。

自己的商品可编辑、下架、重新上架、标记售出或移入「已删除」。删除采用可恢复的回收站：先恢复为下架，再决定是否上架；不会彻底清除数据库记录、联系方式或照片。下架、售出、已删除商品的详情、联系方式及未被其他上架商品引用的照片仅本人可见。其他用户的收藏关联保留，但暂时隐藏不可见商品；商品重新上架后恢复展示。

发布草稿仅保留在当前页面内存中，刷新或关闭页面会丢失，尚不提供跨设备或服务端草稿。提交失败时保留当前页内容；已上传成功的照片可能已在服务端保存，离开页面不代表删除这些文件。完整数据范围与限制见 [PRIVACY.md](PRIVACY.md)。

检查命令：

```powershell
npm test
npm run check
```

正式数据库初始为空，不预置旧版的 18 件虚构商品，也不导入用户浏览器原有的 IndexedDB 数据；后续升级保留已有记录。首次看到空商品列表是正常状态。邮件服务开通后，可用自己控制的学校邮箱及非私人照片验证发布流程。

## 修改入口

| 子系统 | 源码与职责 |
| --- | --- |
| 原生界面 | `public/app.js`、`public/styles.css`；`public/data.js` 只保留分类等界面常量，不包含示例商品 |
| HTML 入口 | `legacy/index.html`；根路由 `app/route.ts` 以 raw HTML 返回它 |
| 交易接口 | `server/market.mjs` 与 `app/api/[[...path]]/route.ts`，处理身份、商品、收藏、联系方式和图片权限 |
| 学校邮箱认证与邮件 | `server/school-auth.mjs` 处理验证码、昵称、限流与会话；`gmail-apps-script/` 提供 Google 托管的发信程序，准备入口 `npm run mail:gmail:setup`；`relay/` 和 `mail:setup` 保留 QQ 备选，另支持 Resend |
| 数据模型与迁移 | `db/schema.ts`、`drizzle/`；D1 存记录，R2 存照片内容 |
| 托管关联 | `.openai/hosting.json`，使用已有项目及 `DB`、`BUCKET` 绑定 |
| 设计交付 | `design/` 与设计生成脚本；`design/demo-data.js` 中的旧假商品只用于静态 SVG 生成 |

**`dist/` 已改为可重新生成的构建产物，不再是手写源码。** 请修改上表中的源文件，再运行构建；不要直接编辑 `dist/`。项目的开发命令、清单和相对路径均以仓库根目录为准。

数据库变更先修改 schema，再运行 `npm run db:generate`，审查并提交新增迁移。迁移只定义结构，不夹带真实数据或演示商品；不得改写已应用的迁移。协作规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 设计与素材

[在线 Figma 文件](https://www.figma.com/design/aj8JjrnlIaFq9QbDJWCq7r?node-id=202-697)保留桌面、手机画板与组件展示。Figma 与网站源码不会自动同步；修改界面后需单独更新设计稿。保留 Monito 参考模板的署名和修改说明，以及静态素材的作者、来源和许可记录。

`design/demo-data.js`、SVG 中的示例商品、昵称和联系号是设计用虚构数据，不是生产种子数据；不得将它们复制进 `public/`、迁移文件或正式数据库。

## 部署与当前限制

自动化检查、本地 Vinext / D1 / R2 联测和浏览器操作应分别记录结果。接口上传成功不能代替照片选择、发布到个人中心的完整 UI 验收；受控邮件测试不能代替真实学校收件箱送达。

QQ 本地链路曾完成真实学校收件、同一浏览器验证码登录和刷新保持会话；这不代表 Gmail 或生产环境已经验收。验证码错误、过期等边界的受控测试和实际收件结果分别记录。当前 Google 授权、Web 应用部署、Sites 发布、学校收件与生产会话结果见 [QA.md](QA.md)，不能只因代码准备或接口确认就宣称全部开通。

已有托管网址：<https://juzi-campus-market.open-bloom-6517.chatgpt.site>。Gmail 路径使用 Google 分配的 HTTPS Web 应用地址，Sites 服务端以签名请求调用，不要求学生访问 Google 或授予权限。正式邮件额度与实际送达仍受 Google 和学校收件系统限制。

Google 账号授权、正式脚本部署和平台秘密值需实际完成后才能启用 Sites 发信；步骤见 [DEPLOYMENT.md](DEPLOYMENT.md)。公开访问、邮件送达和权限分别验收，Cloudflare 拦截结果单独记录，本地成功不能替代公网验收。

**GitHub push 或合并 PR 不会自动部署 Sites。** 数据库版需要通过 Sites 发布到已有项目，步骤和发布记录要求见 [DEPLOYMENT.md](DEPLOYMENT.md)。旧静态版的浏览器验收记录仅说明旧版本行为，不代表数据库版自动通过。
