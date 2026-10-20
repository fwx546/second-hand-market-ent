# 橘子集：协作与自动部署

**当前状态：已启用并验证 Cloudflare Workers Builds。** 2026-10-20，推送 `main` 提交 `8da600b` 自动触发构建 `fd1ae589-011b-489f-af21-ec66f6cebde1`，云端 220 项测试全部通过并发布成功。首个自动发布版本为 `770d453c-35ca-49fd-a5e4-daca9e6b8e86`，后续以控制台最新部署为准。

| 项目 | 配置 |
| --- | --- |
| GitHub 仓库 | [fwx546/second-hand-market-ent](https://github.com/fwx546/second-hand-market-ent) |
| 生产分支 | `main` |
| 现有 Worker | `juzi-campus-market` |
| 公网网址 | <https://juzi-campus-market.wenxin-fu23.workers.dev> |
| Root directory | `/`（仓库根目录） |
| Node.js | `.nvmrc` 指定 `22`；首轮成功使用 `22.23.3`，至少需要 `22.13.0` |
| Build command | `npm test && npm run build:cloudflare` |
| Deploy command | `npx --yes wrangler@4.151.2 deploy --config cloudflare/wrangler.json && node scripts/check-cloudflare-production.mjs` |
| 依赖安装 | 保留 Cloudflare 自动安装，使用仓库中的 `package-lock.json` |
| 其他分支与 PR 预览 | 关闭，不自动发布预览 |

已在 Cloudflare → Workers & Pages → `juzi-campus-market` → Settings → Builds 中连接上述仓库。GitHub App 仅选择此仓库；构建凭据由 Cloudflare 管理，名称为 `Juzi GitHub main auto deploy`，与本机旧的临时部署凭据独立。沿用现有 Worker 与免费套餐。

**日常修改流程**

1. 从最新 `main` 新建分支，修改代码；本地运行 `npm test` 和 `npm run build:cloudflare`。
2. 推送分支并向 `main` 提交 Pull Request，说明改动与验证结果。
3. 审核通过后合并到 `main`。合并产生的提交自动触发测试、构建和正式发布；测试或构建失败会阻止本次发布。直接推送 `main` 同样触发发布。
4. 在 Worker 的部署记录中打开对应提交的构建日志，确认发布成功，再检查首页、商品照片和学校邮箱登录。

发布后自动运行只读检查：匿名访问与学校邮箱登录配置、公开商品列表，以及一张商品图片（优先真实上传）。检查最多 40 秒，不发送验证码、登录或改写数据，日志仅含状态和计数。它不能替代真实收码登录或完整用户操作验收。若发布后检查失败，构建会报错，但已经完成的部署不会自动回滚，应查看固定错误码后修复或手动回滚。

GitHub 仓库协作者可以提交代码；Cloudflare 的设置和回滚需要相应的 Cloudflare 账号权限。只有分支推送或 PR 创建时，不会发布到生产。

**数据与凭据保持**

此流程只构建静态资源并发布 Worker 代码，沿用现有 D1 数据库、Supabase 图片存储及 Worker Secrets。`cloudflare/wrangler.json` 中的现有账号、数据库、存储绑定和公网域名应保持一致。普通运行变量以该配置文件为准，既有 Secrets 会在正常部署中保留。[部署行为说明](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)

生产环境的 `SUPABASE_URL` 与 `SUPABASE_STORAGE_BUCKET` 也保存为远端 Secrets，因此不在生产配置的 `vars` 中重复声明。自动部署无需读取、复制或重建这些值。

不要把数据库迁移、初始化、种示例数据、备份恢复或图片导入命令加入自动构建。不要向仓库、网站静态资源或构建日志提交 `.env`、`.dev.vars`、API 密钥、验证码、用户资料、私有数据库导出或迁移备份；构建也不需要复制本机这些文件。

**排错与回滚**

Cloudflare → Workers & Pages → `juzi-campus-market` 的部署记录中，可以按提交查看构建与发布日志；Settings → Build 用于检查仓库、分支及命令配置。日志若包含私人资料，不要直接公开分享。

若发布后出现问题，在 Worker 的 Deployments 页面选择之前确认可用的版本执行 Rollback；随后通过修复或还原 PR 同步 `main`，避免下一次提交再次发布问题代码。回滚 Worker 版本不会回退 D1 数据库记录或 Supabase 图片，不能用它恢复误删的数据。

**费用约束**

保持 Workers Builds Free：每月上限 **3,000 构建分钟**，免费并发构建数为 1。额度不足时暂停后续构建、等待恢复，不开通付费套餐或额外付费额度。关闭预览以减少无用构建；此构建额度与网站请求、数据库和图片存储各自的免费额度分开计算。[官方额度说明](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)

**跨系统校验**

首轮云端测试发现历史源 SQL 文件混用 LF/CRLF，造成源内容校验和与 Windows 不同。生成器现统一换行，并仅为完全相同的初始迁移内容保留已记录的历史校验和；LF、CRLF、混合换行均通过，实际 SQL 改动仍拒绝。已应用的 `cloudflare/migrations/0001_schema.sql` 字节未改动；这项修复不在生产数据库执行 SQL。
