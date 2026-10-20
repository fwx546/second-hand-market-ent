# 数据库版部署与更新

当前正式站为 <https://juzi-campus-market.wenxin-fu23.workers.dev>，使用独立
Cloudflare Workers/D1 与 Supabase 私有图片存储。更新正式站请使用
[独立托管部署说明](cloudflare/README.md)。下文 Sites/Vinext 流程仅用于历史站和
本地开发；旧站迁移后保持只读，不能重新开启写入来代替新站更新。

本项目采用 Sites 官方 Vinext 运行时，原生界面、API、D1 和 R2 作为同一个应用发布。**不能再把旧静态目录直接上传来获得数据库功能。** `public/`、`legacy/`、`app/` 和 `server/` 是源码；`dist/` 由构建生成。

公网邮件首选 **Gmail + Google Apps Script**，继续使用已有 Sites 应用和数据库，不购买发件域名或租用 Node 服务器。用户已选择暂不产生费用，Render 仅保留 QQ 部署包，未创建收费资源。Gmail 代码接入、账号授权、正式脚本部署、Sites 私密配置及实际收件分别验收；在发送准备完成前保持关闭，实际状态以 [QA.md](QA.md) 为准。

## 现有项目与绑定

继续使用已有项目，不创建平行站点或更换数据库实例。`.openai/hosting.json` 应保留：

```json
{
  "project_id": "appgprj_6ad435c366a881918257d17c988af9a9",
  "d1": "DB",
  "r2": "BUCKET"
}
```

数据库版移除旧的 `static` 配置，D1 绑定名为 `DB`，R2 绑定名为 `BUCKET`。项目 ID 和绑定名不是凭据，也不能代替平台登录和项目访问权限。修改这些名称或项目关联前必须核对实际资源，避免连接到另一份空库或图片桶。

已有网址：<https://juzi-campus-market.open-bloom-6517.chatgpt.site>。公开访问曾遇 Cloudflare 拦截，每次发布后应记录实际访问结果。QQ 本地已完成真实收件与登录，不代表 Gmail 或生产会话已经验收。部署成功、公开可访问、学校收件和登录权限需分别记录。

## 本地准备与验证

使用 Node.js 22.13+，从仓库根目录运行：

```powershell
npm ci
npm test
npm run check
npm run build
npm run dev
```

本轮开发预览统一使用 <http://localhost:4174/>，根配置的 `JUZI_EMAIL_ORIGIN` 也应为 `http://localhost:4174`。`npm run dev` 默认从该精确 Origin 选择端口（未配置时为 4174），先应用项目本地迁移，再启动网站；配置启用 QQ 发信后同时启动中继，按 `Ctrl+C` 停止本次启动的子进程。启动不会发送验证码。

首次使用须先构建，因为本地迁移依赖构建生成的配置。迁移只对本地模拟 D1 应用 `drizzle/` 的新增结构，不迁移托管数据库；可单独执行 `npm run db:migrate`。若中继已手动运行，用 `npm run dev:site` 仅启动网站；特殊环境配置可直接执行 `node scripts/run-framework.mjs dev --port 4174`，自行负责本地迁移和中继。不要重复占用旧服务的端口。本地持久化状态和临时配置位于忽略目录中，不上传、不提交。

本应用仅接受学校邮箱验证码登录与只读访客，不使用宿主平台身份授权交易接口。本地开发同样不能用模拟身份或手写身份头取得发布权限。邮箱验证只证明控制 `@student.xjtlu.edu.cn` 邮箱，不代表核实当前在读学籍。

新环境邮件登录默认关闭。Gmail 路径先运行 `npm run mail:gmail:setup -- 你的Gmail地址`，只准备忽略的 `gmail-apps-script/.env.local`，不改已有 QQ 根配置、不发信、不创建 Google 部署。按下节由发件账号本人完成授权，保存正式端点，再用 `--url` 保存到私有准备文件、用 `--enable` 显式切换本地服务商。启用配置不证明邮件可送达。完整步骤见 [AUTH_SETUP.md](AUTH_SETUP.md)。

已验收的 QQ 回环中继保留备选；单独安装 `npm --prefix relay ci`，运行 `npm run mail:setup -- 你的QQ邮箱` 准备配置。本人生成客户端授权码并私下填入 `relay/.env.local`，再运行 `npm run mail:setup -- --enable`，仅检查格式。该命令会选择本地 QQ 服务商，切换前保留 Gmail 配置。`npm run dev` 自动启动已配置 QQ 中继，或分开运行 `npm run mail:relay` 和 `npm run dev:site`。公开格式见 [.env.example](.env.example)。

QQ 本地中继固定监听 `127.0.0.1:4180`，网站通过 `http://127.0.0.1:4180/send` 调用，QQ SMTP 凭据不进入 Worker。网站与中继的滚动 24 小时额度默认各为 50，失败也计数；`relay/.state/` 的 SQLite 账本持久保存去重和状态，重启不重置，失败或不确定请求不自动重发。不要把环境值加上公开前缀或写进浏览器资源。新增认证迁移仍按“构建 → 本地迁移 → 启动”的顺序验证，不添加真实账号种子。

自动化检查、真实本地运行时 HTTP 联测和浏览器 UI 操作应保留独立结果；接口上传成功不代表文件选择和发布 UI 已完成验收。受控邮件测试不代表学校邮箱真实收信。

QQ 本地曾完成学校收件、同一浏览器验证码登录和刷新保持会话；这些记录不沿用为 Gmail 或生产验收。错误、过期等验证码边界的受控测试与真实邮件结果分别记录，当前自动化检查及浏览器结果见 [QA.md](QA.md)。

有 schema 变更时，先修改 `db/schema.ts` 并运行 `npm run db:generate`，审查新增迁移，再执行上述构建与本地验证。已应用迁移不能改写；普通迁移不得插入真实个人或认证数据。唯一的已授权示例数据例外是下述 `0004_public_demo_catalog.sql`。

基础功能迁移 `0003_sloppy_ulik.sql` 仅为现有表新增 `users.campus`、`products.sold_at` 和 `products.deleted_at`，不重建表、不清空旧记录。数据库仍用原有上架/下架基础列配合时间标记表示售出和回收站状态；应用回退前需确认目标版本能正确处理这些标记，不能让旧版本把非上架记录重新公开。

## Gmail 免费公网发信：Google Apps Script

发件账号本人在 [Apps Script](https://script.google.com/home) 新建项目，把 `gmail-apps-script/Code.js` 复制为 `Code.gs`，按仓库 `appsscript.json` 设置清单。只申请 `https://www.googleapis.com/auth/script.send_mail`，使用 MailApp 发送验证码，不读取 Gmail 收件箱、不要求学生授权 Google。[MailApp](https://developers.google.com/apps-script/reference/mail/mail-app)

在 Script Properties 私下保存 `JUZI_GMAIL_SCRIPT_SECRET`、`ENABLED` 和 `JUZI_GMAIL_DAILY_LIMIT`。共享密钥至少 32 字符，独立于网站验证码 HMAC 密钥；初始关闭，默认 50 次/滚动 24 小时，范围 `1..100`。不要将属性、实际发件地址或密钥提交源码。发件人为实际部署并授权的 Google 账号。

部署类型选 Web 应用，执行身份“我”，访问权限“任何人”，由账号本人审阅授权。保存正式 `https://script.google.com/macros/s/<部署ID>/exec`，不要使用仅供编辑者的 `/dev`。选择任何人访问是为了 Sites 后端无 Google 交互登录地调用；发信仍要求有效正文 HMAC，不向浏览器分发密钥。[Web 应用部署与执行身份](https://developers.google.com/apps-script/guides/web)

脚本验证学校域、6 位验证码、签名与请求时效，只发送固定验证码邮件。脚本锁和 Script Properties 保护持久预留、去重与额度，保存摘要及状态、不保存邮箱或验证码。失败或不确定的预留发送计数且不自动重发。Content Service 响应重定向到 Google 一次性地址，网站适配器只在允许域读取结果，不把发送正文重放给任意地址。[响应重定向](https://developers.google.com/apps-script/guides/content#redirects)

消费级 Gmail 当前额度为 100 收件人/日，首次请求后 24 小时重置；本应用默认 50 次并检查 Google 剩余额度。额度可能调整或被其他脚本使用，免费方案适合小规模试用，公开端点也受执行资源限制。[官方额度](https://developers.google.com/apps-script/guides/services/quotas)

正式启用顺序：

1. 完成账号授权、私密属性与正式部署，记录脚本版本和部署 ID，不记录密钥。
2. 核对发件账号、`/exec` URL、最小权限和独立开关；验证无效签名不能触发发信。
3. 通过 Sites 原生环境设置配置下节变量，先保持网站发信关闭，完成源码发布。
4. 准备就绪后启用脚本和网站，用自控学校邮箱仅申请所需测试邮件，确认收件与同一浏览器登录；结果不确定时先检查，不自动重发。
5. 分别记录原生部署状态、公开访问、学校收件与生产会话；Cloudflare 阻断不由邮件配置自动解决。

更新脚本须在“管理部署”选择新版本，单纯保存编辑器不会更新正式 `/exec`。回退代码时保留 Script Properties 账本，确认旧版本和当前协议兼容。停用先关网站 `JUZI_EMAIL_ENABLED`、再关脚本 `ENABLED`；轮换共享密钥需停发并更新两侧，再发布/重启与实际验收。不要顺便轮换网站 `JUZI_EMAIL_AUTH_SECRET`。详细操作见 [AUTH_SETUP.md](AUTH_SETUP.md)。

## QQ 生产部署包：保留备选，未开通

用户已决定暂不产生费用，**没有创建 Render 收费资源**。仓库保留 `render.yaml` 与独立 `relay/`，不是当前 Gmail 路径的前置条件。以后若选择 QQ 公网中继，仍须单独授权实际资源和费用，再配置服务。

此包准备为 Render 新加坡单实例、Node.js 22.16.0、1 GB 持久盘及 `/healthz`，平台 HTTPS 子域不要求自有域名。免费实例的 SMTP 与持久盘限制使其不适用于本包；未来报价与限制应重新核对，不把旧估价当成承诺。[Render 免费限制](https://render.com/docs/free)、[持久盘](https://render.com/docs/disks)

未来生产须显式 `JUZI_RELAY_MODE=production`、`NODE_ENV=production`，采用平台 `PORT`，持久目录 `QQ_RELAY_DATA_DIR=/var/data`，账本 `QQ_RELAY_DB_PATH=/var/data/relay.sqlite`，精确 HTTPS `JUZI_RELAY_PUBLIC_ORIGIN`（Render 可取平台外部 URL）。QQ 发件账号与授权码只在中继私密环境中，独立 `JUZI_RELAY_TOKEN` 与 Sites `JUZI_EMAIL_RELAY_TOKEN` 匹配，额度 `QQ_RELAY_DAILY_LIMIT=50`。不能复制本地环境文件、回环 URL 或临时账本上线。

必须单实例并保留账本，禁止清盘绕过额度或同时启动共享账本的副本。`/healthz` 不发邮件，不能代替鉴权、持久化、实际学校收件与生产登录验收。生产准备说明同时保留在 [relay/README.md](relay/README.md)。

## 发布到 Sites

继续发布到已有 Sites 项目。应用代码可以先发布，Gmail 正式脚本未就绪时保持发信关闭；生产 Worker 无法连接维护者电脑的回环地址。Google 授权、正式脚本、原生环境配置和实际邮件登录分别验收，不能仅启用本地配置就宣称公网已开通。

1. 由具备已有项目权限的维护者连接 Sites，确认本次源码提交、绑定名和新增迁移已经审查。
2. 使用当前版本安装依赖、运行检查并构建，按 Sites 当次工具要求准备和提交应用源码及构建所需文件。不要复用旧静态包或过期归档。
3. 发布到上面的已有项目。托管环境的 D1 迁移由 Sites 发布流程自动应用；本地 `db:migrate` 不承担此步骤，不自行把它改成远程迁移命令。
4. 检查部署状态、数据库绑定和图片绑定；记录提交号、部署版本、迁移结果、时间以及实际访问验证结果。
5. 用访客浏览器和自己的正式账号验证下述路径。访问被拦截时记录拦截页面和请求标识，不宣称身份链路已经验收。

**GitHub push 或 PR 合并不会自动部署 Sites。** 当前没有因此自动触发的生产发布流程。源码归档不能包含 `.wrangler/`、`.sites-runtime/`、登录状态、Cookie、访问令牌、真实数据库导出或私人照片。

发信端点就绪后，由具有项目权限的维护者通过 **Sites 原生环境设置**注入通用配置：`JUZI_EMAIL_PROVIDER`、`JUZI_EMAIL_ENABLED`、`JUZI_EMAIL_ORIGIN`、`JUZI_EMAIL_AUTH_SECRET` 和明确的 `JUZI_EMAIL_DAILY_LIMIT`。密钥作为服务端秘密值，不写入源码归档或托管清单。当前生产 Origin 为 `https://juzi-campus-market.open-bloom-6517.chatgpt.site`，不含末尾斜线；学生不走 Google OAuth 回调，不修改 Sites 宿主认证路径。

| 生产邮件选项 | Sites 服务端配置 | 独立要求 |
| --- | --- | --- |
| Gmail 首选 | `JUZI_EMAIL_PROVIDER=gmail_apps_script`，`JUZI_GMAIL_SCRIPT_URL` 为严格 Google `/exec` 地址，`JUZI_GMAIL_SCRIPT_SECRET` 为与脚本匹配的秘密值 | 发件账号本人授权 MailApp，并以本人执行、任何人访问部署 HMAC 保护的 Web 应用；不购买自有发件域或 Node 服务 |
| QQ 中继 | `JUZI_EMAIL_PROVIDER=qq_relay`，`JUZI_EMAIL_RELAY_URL` 为已审查的 HTTPS `/send` 地址，`JUZI_EMAIL_RELAY_TOKEN` 为匹配的鉴权令牌 | QQ 发件账号与授权码仅保存在独立中继；不得把本地回环 URL 用于生产 |
| Resend 备选 | `JUZI_EMAIL_PROVIDER=resend`，另填 `JUZI_EMAIL_FROM` 与 `RESEND_API_KEY` | 维护者拥有并验证发件域名，不能冒用学校收件域或 Sites 托管域 |

准备完成后启用并进行独立实际验收。`JUZI_EMAIL_DAILY_LIMIT` 允许 `1..10000`，Gmail 与 QQ 本地准备入口明确设为 `50`；生产也应显式选择额度，失败请求计数，发送端与网站额度需同时满足。新增迁移保留旧账号和认证表历史，但旧会话不获得本应用交易权限。

## 数据上线与验收

维护者已明确要求展示示例物品。新增 `0004_public_demo_catalog.sql` 以 `INSERT OR IGNORE` 写入固定的示例展示账号和 18 件示例商品，并通过 `products.is_demo` 区分；既有用户、学校邮箱账号、会话、真实商品与收藏继续保留。此展示账号没有学校邮箱关联或登录权限，不计为真实注册用户。照片使用已有公共素材，不创建虚构联系方式或上传占位照片到 R2。不导入旧 IndexedDB。

示例记录由数据库返回，不由前端假装成真实商品。上线后通过数据库查看器核对 18 件 `is_demo=1` 商品、三个分类各 6 件，以及既有学校邮箱账号和会话仍在；再验证首页真实/示例计数、照片、详情、收藏和示例联系按钮禁用。应用回退不会移除示例数据或 `is_demo` 列，回退版本也必须保留示例标识与联系限制，不能回到无法识别该列的旧界面。

数据库版上线至少需要确认：

- 访客可以查看空状态或真实上架列表；访客与未登录请求均不能发布、收藏、读取联系方式或个人记录。
- 自己控制的真实学校邮箱收到验证码并完成登录后，可以上传非私人测试照片、发布、编辑和下架自己的商品；账号昵称按此次输入的邮箱前缀去 ASCII 数字生成，保留大小写、最多 20 字符，空结果使用“橘子同学”。完整登录邮箱不出现在公开接口。
- 两个独立浏览器验证同一学校邮箱后，能够读取同一份发布与收藏；另一邮箱不能管理对方商品，宿主平台身份不能绕过验证。
- 上架照片能从 R2 读取；未发布照片只对上传者可见。下架后，其他用户不能继续读取该商品详情或联系方式；未被其他上架商品复用的照片也不再公开读取。
- 登录读取联系方式的接口与公开商品接口分离；所有者账号 ID 不出现在公开商品 DTO 中。
- 页面刷新、校区筛选、移动布局和接口失败提示正常，新增迁移没有破坏已有记录。
- 账号昵称和常用校区更新后保留，为之后的新建商品表单提供默认值；每次验证码登录会重新生成账号昵称，覆盖手动昵称。再次登录或保存资料不改写已有商品的卖家昵称、校区，发布商品也不改写账号昵称。派生昵称可能包含姓名，确认发布后相应商品昵称对访客公开。
- 售出和移入回收站后，商品、联系方式和未被其他上架商品引用的照片对其他人不可见；回收站只恢复为下架，再由本人决定是否重新上架，不是永久清除。
- 收藏关联在商品不可见时保留并暂时隐藏，重新上架后恢复显示；发布草稿仅为页面内存，刷新或关闭会丢失，不能当作服务端草稿验收。

邮箱认证还需验收发送冷却、邮箱/浏览器/全站额度、错误和过期验证码、跨浏览器拒绝、一次使用、会话到期以及退出/选择访客。退出和访客通过本站 POST 接口清除当前会话并重新确认匿名状态，不再执行宿主平台登出。原有数据保留，不自动与新邮箱账号合并。

完整步骤见 [AUTH_SETUP.md](AUTH_SETUP.md)。服务未开通时保持默认关闭；准备命令不能证明 Google 授权或送达，QQ 格式检查不能验证凭据，发送确认本身仅表示服务商接受邮件。QQ 本地结果与受控测试均不能替代 Gmail 实际收件或生产会话验收。

在本次线上复测完成之前，上述路径不能自动标记为已通过。若仍遇 Cloudflare 拦截，应记录具体失败位置并继续核查；本地成功不能替代生产验收，也不据旧版访问问题宣称新版已经失败。

## 更新与回退

通过同一项目发布后续版本，保留应用提交和迁移版本的对应关系。变更数据库时优先保持旧、新应用均可读取的兼容结构，先评审已有记录的影响。

回退应用代码不等于回退 D1 数据或 R2 对象，也不会自动撤销已应用迁移。需要回退时，先核对目标应用与当前 schema 是否兼容，再选择重新发布兼容版本或新增修复迁移。涉及真实数据恢复、删除或导出时，单独制定并授权操作方案；不要直接覆盖或清空数据库和图片桶。

下架、售出和回收站删除均为业务状态变更，不能用来宣称已彻底清除底层记录和照片。字段可见范围、已下载内容和数据保留限制见 [PRIVACY.md](PRIVACY.md)。
