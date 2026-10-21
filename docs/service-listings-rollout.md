# 服务类上线说明

## 当前交付

代码在 `feat/service-listings`，尚未合并 `main`，不会自动发布。改造包含服务分类、动态表单、计价单位、方向/方式筛选、详情、联系方式及暂停/恢复接单。原有实物保持原类别；误归为生活用品的服务由发布者主动编辑改类并补齐信息。

## 数据库变更

- 本地 / 历史 Sites：`drizzle/0009_service_listings.sql`（schema 与生成快照已同步）。
- 当前正式 Cloudflare：`cloudflare/migrations/0002_service_listings.sql`。
- 已应用的 `0001_schema.sql` 不得覆盖或重跑。schema 检查保留原始迁移 0000–0008 的快照，并验证增量迁移最终与全部 Drizzle 迁移一致。
- SQLite CHECK 约束变更需要重建 products。D1 的延迟外键检查不会阻止 ON DELETE CASCADE，因此迁移暂存并恢复联系方式、图片关联、收藏、对话和消息，再清理暂存表。详见 [Cloudflare 外键说明](https://developers.cloudflare.com/d1/sql-api/sql-statements/)。
- 测试在开启外键的事务中逐行比较上述数据，检查 foreign_key_check，并验证迁移后可创建服务。

## 正式上线顺序（有 Cloudflare 权限的维护者执行）

1. 审核 PR，确认使用现有账号和 D1 数据库，不创建新数据库或修改邮箱/存储 Secrets。
2. 在 Worker 设置中临时把 `JUZI_SITE_ENABLED` 改为字符串 `false` 并部署该设置，停止 API 读写。先备份数据库并保存恢复点、迁移前逐表计数；备份放在忽略目录，禁止提交或发到聊天。以下为从仓库根目录执行的示例，备份文件名每次使用新的时间戳：

   ```powershell
   New-Item -ItemType Directory -Force .migration-staging | Out-Null
   $backupStamp = Get-Date -Format yyyyMMdd-HHmmss
   npx --yes wrangler@4.151.2 d1 export DB --remote --config cloudflare/wrangler.json --output ".migration-staging/before-services-$backupStamp.sql"
   ```

3. 在测试数据库用同一份增量文件演练并核对数据；确认正式库仍是旧分类约束后，执行**一次**增量文件，不在控制台逐条粘贴，不执行整个旧初始化文件：

   ```powershell
   npx --yes wrangler@4.151.2 d1 execute DB --remote --config cloudflare/wrangler.json --file cloudflare/migrations/0002_service_listings.sql
   ```

   使用一次 D1 文件执行操作，文件内不添加 BEGIN/COMMIT。若报错，保持暂停写入，检查事务结果及暂存表，禁止直接重试或删除数据。不要盲目运行 migrations apply：初次部署可能通过文件初始化，旧初始化文件未必登记为已应用。

4. 核对迁移前后逐表数量及内容，执行 `PRAGMA foreign_key_check`，应无结果；确认不存在 `__service_backup_` 或 `__new_products` 残留。成功后可将启用变量恢复为 `true`：旧代码仍支持原来的实物数据。
5. 合并 PR 到 `main`，等待 Cloudflare Workers Builds 测试、构建、部署与只读检查全部成功。配置文件仍为 `JUZI_SITE_ENABLED=true`。
6. 正式站刷新后验证：访客筛选、学校邮箱登录、服务选图发布、详情单位、编辑/切换方式、收藏、消息、暂停/恢复接单，以及旧实物正常展示。真实邮箱收码需由控制收件箱的用户验证。

## 回退与限制

- 迁移后旧代码仍可读取原有实物；新版发布失败时可先维持旧版并排查。
- 一旦产生 service 记录，旧代码不理解该分类。代码回退前先暂停 API，保留全部数据并制定兼容修复，不能直接恢复备份覆盖之后的新记录。
- 自动部署不会执行数据库迁移。GitHub push 权限不等于 Cloudflare 管理权限。本次未执行正式迁移、未发送真实验证码、未改正式站数据。
- 本地浏览器验证完成服务字段切换、自定义计价、线上/线下地点和服务筛选弹窗；320、390、1440 CSS 像素宽度下服务表单无横向溢出。
- 浏览器选图未完成：Chrome 扩展需允许文件网址访问。接口上传、发布、持久化、权限和迁移保留数据由自动测试验证；这不替代完整的浏览器选图发布或正式站验收。
