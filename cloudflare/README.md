# Standalone hosting runtime

## 账号、免费方案与所有权

Cloudflare 和 Supabase 账号与 ChatGPT 账号独立。本次按用户最新授权使用
当前已登录的账号管理资源：

- Cloudflare：`wenxin.fu23@student.xjtlu.edu.cn`，账号 ID
  `5b0ae0b84289b5093c8ebbd70d3dae88`。
- Supabase：通过 GitHub `WenxinFu050406` 登录，使用已有 Free 组织
  `rvmdnmqmvirighbnqmcv`，新项目为 `igulpkuyggfxlqojnzyi`。

独立网站程序已于 **2026-10-20** 部署到
<https://juzi-campus-market.wenxin-fu23.workers.dev>，但仍处于迁移维护状态：
`JUZI_SITE_ENABLED=false`，目标数据库尚未导入业务记录，原始图片尚未迁入。
本机访问新域名超时，公网浏览器与邮件验收尚未完成，不能将其作为已完成迁移的网站交付。
旧 Sites 网站继续保留，临时只读状态已解除。后续由上述账号管理
对应的云端资源，本次无需注册 QQ 邮箱账号、迁移 GitHub 仓库所有权或购买
ChatGPT Business。平台若要求填写付款方式或升级套餐，应停止该步骤并
检查是否选择了 Free。

本部署使用 **Cloudflare Workers Free + D1 Free + Supabase Storage Free**。
数据库是 Cloudflare D1，并非 Supabase PostgreSQL；图片放在 Supabase 私有
Storage bucket。这样可以复用旧站 SQLite 数据结构和邮箱验证码登录。
不会创建 Cloudflare R2 bucket 或开通其计费。

- D1 Free 的单个数据库上限是 **500 MB**，账号存储总上限为 5 GB；每天还有
  读写额度和单次请求的查询次数限制。
- Supabase Free 提供 **1 GB** 文件存储；流量和其他资源也有免费限额，低活跃
  项目可能暂停。恢复和免费额度以该项目控制台为准。
- 只选择 Free，不升级、不绑定付款方式或启用付费资源。免费额度用完时应处理
  停用/限流提示，不能为了恢复服务自动升级。

官方依据：[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、
[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)、
[Supabase Free](https://supabase.com/pricing)。

## 本地构建与部署配置

先在项目根目录运行，使用 Node 22.13 或更新版本：

```powershell
npm.cmd run build:cloudflare
node scripts/generate-cloudflare-schema.mjs --check
```

构建脚本仅复制 `public/` 的常规静态文件和 `legacy/index.html`，生成目录为
`cloudflare/.output/public`。会保留图片来源说明，生成静态安全响应头，排除
隐藏文件、环境文件、数据库文件和备份。该目录已加入 Git 忽略规则。
脚本在删除旧构建目录前检查绝对路径及符号链接，不会清理旧站源码或数据。

`wrangler.example.json` 不含虚构账户、数据库 UUID、API 密钥或站点 URL。
创建免费 Worker/D1/Supabase 项目后，将控制台返回的真实、非密钥标识填入：

```powershell
$cfAccountId = Read-Host 'Cloudflare account ID'
$cfDatabaseId = Read-Host 'D1 database UUID'
$sbProjectUrl = Read-Host 'Supabase project HTTPS URL'
node scripts/configure-cloudflare.mjs --account-id $cfAccountId --database-id $cfDatabaseId --supabase-url $sbProjectUrl
```

这会生成独立的 `cloudflare/wrangler.json`，不会修改 `.openai/hosting.json`。
账号 ID、数据库 UUID、项目 URL 不是密钥；该文件可以随源码提交。生成器
默认将 `JUZI_SITE_ENABLED` 设为 `false`，拒绝更换已配置的账户/数据库，也
拒绝 R2、付费资源绑定及写在 vars 中的密钥。

部署时必须明确指定 `--config cloudflare/wrangler.json`。例如，在完成免费
资源核验后，由有权限的操作者运行本地已安装的 Wrangler：

```powershell
node node_modules/wrangler/bin/wrangler.js d1 migrations apply DB --remote --config cloudflare/wrangler.json
node node_modules/wrangler/bin/wrangler.js deploy --config cloudflare/wrangler.json
```

上述命令会进行云端操作；构建与配置脚本本身不会执行它们。首个 schema
迁移 `cloudflare/migrations/0001_schema.sql` 从全部现有 Drizzle 迁移在内存
SQLite 中执行后提取，仅包含最终表/索引，无示例数据、用户数据或图片。
业务数据应由单独的私有迁移流程导入，不应提交到迁移 SQL。

取得实际公网 HTTPS 地址后，再运行配置器并增加 `--site-origin`，随后重新
部署；地址必须是精确 origin，不带末尾 `/`、路径或 `#`。验证码发信仍沿用
已授权的 Gmail 签名接口。发信脚本 URL 可在服务器环境配置，所有签名密钥
只能用平台 secrets 存储。迁移数量、关联和图片哈希校验完成后，才将
`JUZI_SITE_ENABLED` 改成字符串 `true` 并发布。用户需在新网址重新登录，
数据库中原有用户 ID 与其商品归属应保持不变。

## 私有数据迁移与验收

以下是待执行的迁移流程，不代表数据已经迁入。先准备旧站
临时、到期失效的只读导出能力，并保持新站 `JUZI_SITE_ENABLED=false`。
私有配置文件保存导出令牌及目标 Supabase Storage 配置，其中的密钥不能
提交、打印或写入命令参数。每次完整导出使用新的运行目录：

```powershell
$migrationRun = '.migration-staging/run-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$migrationEnv = Read-Host '私有迁移配置文件路径'
node scripts/migrate-cloudflare.mjs export --run $migrationRun --env-file $migrationEnv
node scripts/migrate-cloudflare.mjs prepare --run $migrationRun
```

如果维护工具访问旧站被拦截，而维护者自己的正常浏览器仍可访问，可临时启用
旧站的 `/api/migration-export/operator` 下载页。该页默认关闭，到期后失效；
迁移令牌仅输入旧站的密码框，不能写入网址、聊天或仓库。页面会完整枚举源桶，
顺序下载原图，并在前后复核业务记录与桶清单；发生变化时不生成备份。
该备份包含账号资料和联系方式，只保存到本人电脑。

将正常浏览器下载的 JSON 转为同一私有迁移格式，再继续下方验证流程：

```powershell
$browserBackup = Read-Host '下载的 juzi-private-backup JSON 完整路径'
node scripts/import-browser-export.mjs --input $browserBackup --run $migrationRun
node scripts/migrate-cloudflare.mjs prepare --run $migrationRun
```

浏览器路径限 128 个对象、单张 8 MiB、图片共 32 MiB、下载文件 64 MiB。
本机转换会重新校验 SHA-256、可用的原始 MD5 ETag、字节数与图片类型，随后
由同一 `loadExport` 验证器检查全部图片关联。它不写入数据库或 Supabase。
浏览器备份也不能证明下载后源站没有变化；正式导入前仍需冻结写入并复核。

`export` 在忽略的私有目录保存完整源数据库快照、源桶全部分页对象（包括
未关联商品的对象）、原始对象元数据及 SHA-256。`prepare` 核验备份，生成
`prepared.private.sql` 与 `expected-target.private.json`；仅使用受信任的
目标 DDL，不执行源数据库提供的 SQL。源中的旧成色值会映射为当前值，
旧表缺少的新增字段使用目标默认值，不补造用户或示例商品。

按以下顺序操作目标数据库与图片：

1. 按 `expected-target.private.json` 的 `tables` 顺序，将各表的完整
   `SELECT *` 合并为一次 Wrangler
   `d1 execute DB --remote --config cloudflare/wrangler.json --command ... --json`
   执行，将逐表 JSON 结果数组保存为运行目录下
   `actual-empty.private.json`（UTF-8，无 BOM）。查询结果不能打印到聊天、
   提交到 Git 或放入静态目录。远程 `--file` 只返回导入汇总，不能用于收集
   逐表验证结果。
2. 执行下列空目标检查与导入命令。生成的 SQL 首条还会强制检查全部业务及
   认证表为空，防止检查后出现新记录或误向已有数据的目标导入。

   ```powershell
   node scripts/migrate-cloudflare.mjs verify-empty --run $migrationRun --actual-db "$migrationRun/actual-empty.private.json"
   node node_modules/wrangler/bin/wrangler.js d1 execute DB --remote --config cloudflare/wrangler.json --file "$migrationRun/prepared.private.sql" --json
   node scripts/migrate-cloudflare.mjs images --run $migrationRun --env-file $migrationEnv
   ```

3. 从同一目标重新收集完整逐表结果到 `actual-db.private.json`，然后运行
   `node scripts/migrate-cloudflare.mjs verify-db --run $migrationRun --actual-db "$migrationRun/actual-db.private.json"`。
   所有表的行数和类型敏感 SHA-256 均须一致；另执行目标
   `PRAGMA foreign_key_check`，结果必须为空。图片导入会逐个回读并校验大小、
   SHA-256 与内容类型，已有不同内容的同名对象会拒绝覆盖。原始 HTTP/custom
   元数据保留在私有备份中，目标传输目前只保证 `contentType`。

持久账号、学校邮箱绑定、商品归属、收藏、联系方式及源中已有的对话/消息
均应保留。仅在目标重置 `auth_flows`、`auth_sessions` 和
`school_email_challenges` 这些临时登录状态；新域名首次访问需要重新获取
验证码登录，已有邮箱仍应关联原用户 ID。

启用新站前记录快照时点，复核源表数据与源桶清单是否又有变化；有差异先
处理，不能向非空目标重放整包。旧、新站之间没有持续同步。全部校验完成
后再启用新站，并撤销旧站临时导出能力。

导出中断后需使用新运行目录重新导出；图片导入可重跑，会重新核验已存在
的对象。数据库导入和图片复制之间没有跨服务事务，数据库失败不会自动
撤回已复制的图片。回退应用代码也不会回退数据；新站开始接收发布、收藏
或消息后，旧站不会自动得到这些记录。需要回退时先关闭新站 API 并保留
数据，再制定恢复或合并方案，不能直接清空数据库或图片桶。

## Runtime bindings

`worker.mjs` serves the existing market and school-email OTP handlers without
Sites, OIDC, or local-preview authentication. Product/account data stays in a
Cloudflare D1 binding named `DB`. Uploaded images use a **private** Supabase
Storage bucket; the Worker exposes the existing permission-checked
`/api/media/<id>` route. Supabase does not receive school login sessions.

The separate deployment configuration must bind:

| Name | Purpose |
| --- | --- |
| `DB` | Independent Cloudflare D1 database with the repository schema |
| `ASSETS` | Curated static files from `public/` plus `legacy/index.html` as `index.html` |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co`, without a custom path |
| `SUPABASE_STORAGE_BUCKET` | Existing private bucket, default `juzi-market-private` |
| `SUPABASE_SECRET_KEY` | Server-only `sb_secret_...` key in Cloudflare secrets |
| `JUZI_SITE_ENABLED` | String `true` only after database/image migration verification |

Keep the existing school-email provider variables, including
`JUZI_EMAIL_PROVIDER=gmail_apps_script`, in the Worker environment. Change
`JUZI_EMAIL_ORIGIN` to the **new exact HTTPS origin**. Store
`JUZI_EMAIL_AUTH_SECRET` and `JUZI_GMAIL_SCRIPT_SECRET` as Worker secrets,
without including them in a static build, Git commit, log, or command argument.
The existing signed Google Apps Script mail endpoint is reusable.

During initial deployment and data migration, omit `JUZI_SITE_ENABLED` or set it
to `false`: API reads and writes, including email sends, then return 503 while
the static shell remains available. Set it to `true` only after checking the
complete imported rows and image hashes. Existing users sign in again on the
new domain; their durable user IDs and published records must be imported.

The Storage adapter supports `get`, `head`, `put`, and `delete`, with an 8 MiB
object limit matching the existing upload handler. It never creates a bucket,
changes billing, makes public URLs, follows redirects, or lists all objects.
Migration enumerates the complete source bucket with every listing cursor,
copies unreferenced objects too, and checks every imported `media` reference
against that complete object manifest.
For a new Supabase secret key, only the `apikey` header is sent. A legacy JWT
`SUPABASE_SERVICE_ROLE_KEY` remains a compatibility fallback and adds a Bearer
header; publishable and `anon` keys are rejected.

No backend credentials are needed in browser JavaScript. The private bucket
must remain private and have no public/client upload policy. School-email
verification and product ownership continue to be checked by the Worker.

Run the isolated tests with Node 22.13 or newer:

```powershell
node --test tests/cloudflare-storage.test.mjs tests/cloudflare-worker.test.mjs
```

The tests use SQLite and injected fake transports; they send no mail, upload no
real images, and contact no production account. A mock passing suite does not
confirm that cloud resources have been created or deployed.
