# 橘子集：协作与自动部署

**当前状态：待连接 Cloudflare Workers Builds。** 以下为约定配置；须完成 GitHub 连接并确认首个构建成功后，才能视为自动部署已启用。

| 项目 | 配置 |
| --- | --- |
| GitHub 仓库 | [fwx546/second-hand-market-ent](https://github.com/fwx546/second-hand-market-ent) |
| 生产分支 | `main` |
| 现有 Worker | `juzi-campus-market` |
| 公网网址 | <https://juzi-campus-market.wenxin-fu23.workers.dev> |
| Root directory | `/`（仓库根目录） |
| Node.js | `22`，至少 `22.13.0`；可设置构建变量 `NODE_VERSION=22.16.0` |
| Build command | `npm test && npm run build:cloudflare` |
| Deploy command | `npx --yes wrangler@4.151.2 deploy --config cloudflare/wrangler.json` |
| 依赖安装 | 保留 Cloudflare 自动安装，使用仓库中的 `package-lock.json` |
| 其他分支与 PR 预览 | 关闭，不自动发布预览 |

由有权限的成员在 Cloudflare → Workers & Pages → `juzi-campus-market` → Settings → Build 中连接上述仓库，设置生产分支与命令。连接现有 Worker，沿用现有免费套餐。

**日常修改流程**

1. 从最新 `main` 新建分支，修改代码；本地运行 `npm test` 和 `npm run build:cloudflare`。
2. 推送分支并向 `main` 提交 Pull Request，说明改动与验证结果。
3. 审核通过后合并到 `main`。自动部署启用后，合并产生的提交触发测试、构建和正式发布；测试或构建失败会阻止本次发布。
4. 在 Worker 的部署记录中打开对应提交的构建日志，确认发布成功，再检查首页、商品照片和学校邮箱登录。

GitHub 仓库协作者可以提交代码；Cloudflare 的设置和回滚需要相应的 Cloudflare 账号权限。只有分支推送或 PR 创建时，不会发布到生产。

**数据与凭据保持**

此流程只构建静态资源并发布 Worker 代码，沿用现有 D1 数据库、Supabase 图片存储及 Worker Secrets。`cloudflare/wrangler.json` 中的现有账号、数据库、存储绑定和公网域名应保持一致。普通运行变量以该配置文件为准，既有 Secrets 会在正常部署中保留。[部署行为说明](https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy)

不要把数据库迁移、初始化、种示例数据、备份恢复或图片导入命令加入自动构建。不要向仓库、网站静态资源或构建日志提交 `.env`、`.dev.vars`、API 密钥、验证码、用户资料、私有数据库导出或迁移备份；构建也不需要复制本机这些文件。

**排错与回滚**

Cloudflare → Workers & Pages → `juzi-campus-market` 的部署记录中，可以按提交查看构建与发布日志；Settings → Build 用于检查仓库、分支及命令配置。日志若包含私人资料，不要直接公开分享。

若发布后出现问题，在 Worker 的 Deployments 页面选择之前确认可用的版本执行 Rollback；随后通过修复或还原 PR 同步 `main`，避免下一次提交再次发布问题代码。回滚 Worker 版本不会回退 D1 数据库记录或 Supabase 图片，不能用它恢复误删的数据。

**费用约束**

保持 Workers Builds Free：每月上限 **3,000 构建分钟**，免费并发构建数为 1。额度不足时暂停后续构建、等待恢复，不开通付费套餐或额外付费额度。关闭预览以减少无用构建；此构建额度与网站请求、数据库和图片存储各自的免费额度分开计算。[官方额度说明](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)
