# 橘子集 · 西交利物浦大学校园二手交易平台

面向西交利物浦大学的 SIP 校区与太仓校区，交易类别为小电器、电瓶车和生活用品。保留原生 HTML/CSS/JavaScript 界面，使用 Sites 官方 Vinext 后端、D1 数据库和 R2 图片存储。首页、商品详情、发布与个人中心均适配桌面和手机。

本站提供**学校邮箱验证码登录**和**访客浏览**。访客可搜索、筛选和查看公开商品；发布、收藏、卖家联系方式和个人记录需要验证 `@student.xjtlu.edu.cn` 邮箱。邮箱验证只证明该邮箱的控制权，**不代表核实当前在读学籍或所在校区**。卖家自行填写公开昵称和交易联系方式，登录邮箱不作为公开卖家资料。具体字段和下架效果见 [PRIVACY.md](PRIVACY.md)。

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

目前没有配置邮件服务，邮箱登录默认关闭，页面会明确提示；可以先使用访客浏览。开通时需要维护者的 Resend 账号和自有、已验证的发件域名，按 [AUTH_SETUP.md](AUTH_SETUP.md) 配置 `.env.local` 或 Sites 服务端环境值，空白样例见 [.env.example](.env.example)。学校邮箱是收件地址，不用于冒充校方发信。

本地开发也必须通过邮箱验证码取得交易权限，不提供模拟业务账号。宿主平台的登录状态不授予本应用权限。选择访客或退出会清除本站会话；历史商品与收藏保留，不会自动合并到新邮箱账号。

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
| 学校邮箱认证 | `server/school-auth.mjs`；验证码校验、限流、会话及 Resend 服务端邮件发送 |
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

已有托管网址：<https://juzi-campus-market.open-bloom-6517.chatgpt.site>。当前公开访问仍有 Cloudflare 拦截，真实邮件服务尚未配置，学校收信和生产会话尚未验收。邮件接口返回 ID 只表示服务商接受发送；访问可用性、邮件送达及生产权限需分别验证。

**GitHub push 或合并 PR 不会自动部署 Sites。** 数据库版需要通过 Sites 发布到已有项目，步骤和发布记录要求见 [DEPLOYMENT.md](DEPLOYMENT.md)。旧静态版的浏览器验收记录仅说明旧版本行为，不代表数据库版自动通过。
