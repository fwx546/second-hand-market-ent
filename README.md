# 橘子集 · 西交利物浦大学校园二手交易平台

面向西交利物浦大学的 SIP 校区与太仓校区，交易类别为小电器、电瓶车和生活用品。保留原生 HTML/CSS/JavaScript 界面，使用 Sites 官方 Vinext 后端、D1 数据库和 R2 图片存储。首页、商品详情、发布与个人中心均适配桌面和手机。

这是数据库版：上架商品对访客公开，发布与收藏按登录账号保存，同一账号可跨浏览器、跨设备访问。平台保留 ChatGPT 登录，并提供可配置的手机号 / 微信托管登录接入；外部服务尚未开通时默认关闭，配置步骤见 [AUTH_SETUP.md](AUTH_SETUP.md)。所有登录方式均**不验证学校、学籍或校区身份**。卖家自行填写公开昵称和交易联系方式；平台不会把登录档案自动作为卖家资料公开。登录用户可查看上架商品的联系方式，具体字段和下架效果见 [PRIVACY.md](PRIVACY.md)。

交易仍通过卖家联系方式沟通和线下面交完成；当前没有站内私信、订单或支付功能。

## 本地启动

需要 **Node.js 22.13.0 或更高版本**及 npm。从仓库根目录运行：

```powershell
npm ci
npm run build
npm run db:migrate
npm run dev
```

默认打开 <http://localhost:5173/>，按 `Ctrl+C` 停止。首次启动或新增迁移后，先构建，再迁移本地数据库。`npm run db:migrate` 只操作本地模拟数据库；正式迁移由 Sites 发布流程应用。

portable 本地开发环境使用模拟账号 `local_seedy` / `seedy@sites.test`。它仅用于本地开发，不能作为正式 ChatGPT 登录已通过的证据。正式托管环境使用平台登录，不使用这组模拟身份。

手机号和微信登录使用支持 OIDC 的服务商托管页面，本站不收集短信验证码。需要先在服务商控制台开通方式，再按 [AUTH_SETUP.md](AUTH_SETUP.md) 填写 `.env.local` 或 Sites 服务端环境值；空白样例见 [.env.example](.env.example)。默认开关为关闭，不能将尚未开通的入口视为真实短信或微信授权已可用。外部账号不会自动合并原 ChatGPT 账号记录。

检查命令：

```powershell
npm test
npm run check
```

正式数据库初始为空，不预置旧版的 18 件虚构商品，也不导入用户浏览器原有的 IndexedDB 数据。首次看到空商品列表是正常状态。请用测试账号自行上传非私人照片，创建测试商品验证流程。

## 修改入口

| 子系统 | 源码与职责 |
| --- | --- |
| 原生界面 | `public/app.js`、`public/styles.css`；`public/data.js` 只保留分类等界面常量，不包含示例商品 |
| HTML 入口 | `legacy/index.html`；根路由 `app/route.ts` 以 raw HTML 返回它 |
| 交易接口 | `server/market.mjs` 与 `app/api/[[...path]]/route.ts`，处理身份、商品、收藏、联系方式和图片权限 |
| 数据模型与迁移 | `db/schema.ts`、`drizzle/`；D1 存记录，R2 存照片内容 |
| 托管关联 | `.openai/hosting.json`，使用已有项目及 `DB`、`BUCKET` 绑定 |
| 设计交付 | `design/` 与设计生成脚本；`design/demo-data.js` 中的旧假商品只用于静态 SVG 生成 |

**`dist/` 已改为可重新生成的构建产物，不再是手写源码。** 请修改上表中的源文件，再运行构建；不要直接编辑 `dist/`。项目的开发命令、清单和相对路径均以仓库根目录为准。

数据库变更先修改 schema，再运行 `npm run db:generate`，审查并提交新增迁移。迁移只定义结构，不夹带真实数据或演示商品；不得改写已应用的迁移。协作规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 设计与素材

[在线 Figma 文件](https://www.figma.com/design/aj8JjrnlIaFq9QbDJWCq7r?node-id=202-697)保留桌面、手机画板与组件展示。Figma 与网站源码不会自动同步；修改界面后需单独更新设计稿。保留 Monito 参考模板的署名和修改说明，以及静态素材的作者、来源和许可记录。

`design/demo-data.js`、SVG 中的示例商品、昵称和联系号是设计用虚构数据，不是生产种子数据；不得将它们复制进 `public/`、迁移文件或正式数据库。

## 部署与当前限制

当前已记录 15 项后端测试通过。真实本地 Vinext、D1/R2 的 HTTP 联测和浏览器 UI 验收需分别记录结果；浏览器文件选择器尚未成功调起，**不能把接口上传测试视为上传 UI 完整链路已经验收**。

已有托管网址：<https://juzi-campus-market.open-bloom-6517.chatgpt.site>。旧静态版曾记录发布成功、后台 `active/public`，也曾遇到 Cloudflare 访问拦截。数据库版需要发布后重新验证，当前没有足够证据宣称新版已正式部署、公开访问或线上身份链路已验收；也不据旧拦截记录提前判定新版访问失败。本地模拟测试不能代替正式账号、D1 与 R2 的线上验证。

**GitHub push 或合并 PR 不会自动部署 Sites。** 数据库版需要通过 Sites 发布到已有项目，步骤和发布记录要求见 [DEPLOYMENT.md](DEPLOYMENT.md)。旧静态版的浏览器验收记录仅说明旧版本行为，不代表数据库版自动通过。
