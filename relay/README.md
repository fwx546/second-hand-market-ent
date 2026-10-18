# QQ 验证码邮件中继

本目录是单独的 Node 22 服务。默认保持本地模式，只监听 `127.0.0.1:4180`；公网模式必须显式开启，并配置 HTTPS 入口和持久磁盘。接收网站服务端的 `POST /send`，不会在启动或健康检查时验证 SMTP 或发信。此前已完成一次真实本地链路：1 封验证码邮件获 QQ 接受并在维护者控制的学校 OWA 中确认收到，同一浏览器校验成功，刷新后会话保持。公网部署准备已完成；云服务创建、付费确认、生产密钥配置和公网实测尚未完成。

QQ 发件设置为固定 `smtp.qq.com:465`、SSL/TLS、TLS 1.2 以上并校验证书。QQ 邮箱需自行在网页版设置里开启 SMTP 并生成客户端授权码。用户名是自己的完整数字 QQ 邮箱，密码是 16 位字母授权码，不能填写 QQ 登录密码。请参见[腾讯官方 SMTP 配置](https://cloud.tencent.com/document/product/1207/45117)。

依赖与网站分开：`npm ci --prefix relay` 只安装本目录锁定的 Nodemailer 10.1.3。Node 使用 `node:sqlite`，需 22.13 以上。根目录启动命令和配置向导见根目录 [AUTH_SETUP.md](../AUTH_SETUP.md)。直接运行时使用 `node --env-file=relay/.env.local relay/run.mjs`。

| 私有配置 | 用途 |
| --- | --- |
| `QQ_SMTP_USER` | 自己的数字 QQ 邮箱；仅固定为该邮箱发信 |
| `QQ_SMTP_AUTH_CODE` | QQ 生成的 16 位字母客户端授权码 |
| `JUZI_RELAY_TOKEN` | 与网站 `JUZI_EMAIL_RELAY_TOKEN` 匹配的至少 32 字符随机令牌 |
| `QQ_RELAY_DAILY_LIMIT` | 可选，默认 50 次/滚动 24 小时，允许 1–1000；不是 QQ 服务商承诺的额度 |
| `QQ_RELAY_HOST` | 仅允许 `127.0.0.1` |
| `QQ_RELAY_PORT` | 默认 4180，可选 1–65535 的未占用端口 |
| `QQ_RELAY_DB_PATH` | 默认 `relay/.state/relay.sqlite`；相对路径以本目录为起点 |

默认 `JUZI_RELAY_MODE=local`。即使环境存在 `PORT`、`NODE_ENV=production` 或 Render 默认变量，也不会把本地服务改为公网监听。本地 `.env.local` 不应上传到云平台。

## Render 公网部署

仓库根目录 [render.yaml](../render.yaml) 提供可审查的 Blueprint：Node 22.16.0、`rootDir: relay`、`npm ci --omit=dev` 构建、`node run.mjs` 启动，新加坡区域、`0.5c-512mb` 付费实例、单进程单实例、1 GB `/var/data` 持久磁盘、`/healthz` 健康检查和手动部署。它不包含凭据；创建资源前应核对控制台中的实际月费。Render 免费 Web 服务[阻止 SMTP 出站端口且不支持持久磁盘](https://render.com/docs/free)，不适用于此方案。

生产环境要求：

| 环境变量 | 生产值／用途 |
| --- | --- |
| `JUZI_RELAY_MODE` | 必须为 `production` |
| `NODE_ENV` | 必须为 `production` |
| `PORT` | Render 提供，默认 `10000`；监听 `0.0.0.0` |
| `JUZI_RELAY_PUBLIC_ORIGIN` | 可选，完整 HTTPS 来源，无末尾斜线、路径、查询或端口；自定义域名时显式设置 |
| `RENDER_EXTERNAL_URL` | 仅在平台 `RENDER=true` 且未显式设置来源时，使用该[Render 官方默认变量](https://render.com/docs/environment-variables)的 HTTPS 地址 |
| `QQ_RELAY_DATA_DIR` | 必须为独立持久磁盘挂载目录，Blueprint 设置 `/var/data` |
| `QQ_RELAY_DB_PATH` | 必须为挂载目录之内的绝对文件路径，Blueprint 设置 `/var/data/relay.sqlite` |
| `QQ_SMTP_USER` / `QQ_SMTP_AUTH_CODE` | 通过云服务私密环境设置填写自有 QQ 账号和授权码 |
| `JUZI_RELAY_TOKEN` | 通过私密环境设置填写新的生产随机令牌；网站 `JUZI_EMAIL_RELAY_TOKEN` 使用同一值 |
| `QQ_RELAY_DAILY_LIMIT` | Blueprint 默认 `50`，所有失败和未知尝试仍占额度 |

生产不得设置 `QQ_RELAY_HOST`、`QQ_RELAY_PORT`，也不能使用内存或相对账本路径。不同环境的令牌和账本分开；保留生产账本期间保持对应令牌稳定。系统验证配置路径归属，且要求挂载目录已存在，不会自行创建缺失的生产挂载目录；这不能代替云平台挂载真实持久磁盘，仍需在部署控制台确认磁盘已挂载。不能横向扩容、启动集群／多个 Node 进程，也不能以更换临时实例重置账本。Render 带磁盘服务[部署时有短暂停机](https://render.com/docs/disks)，届时网站应提示稍后重试。

`GET /healthz` 仅做一次 `SELECT 1` 并返回 `{ "ok": true }`，不需要 Bearer 令牌、不发送邮件、不查询或消耗额度、不暴露环境或账本详情。请求必须匹配生产入口 `Host`；不信任 `X-Forwarded-Host` 或 `X-Forwarded-Proto` 覆盖来源。Render [健康检查的 Host](https://render.com/docs/health-checks) 使用其 `onrender.com` 子域名，配置自定义域名后使用已验证的自定义域名，因此修改域名时必须同步 `JUZI_RELAY_PUBLIC_ORIGIN`。所有带 `Origin` 的请求仍被拒绝；没有 CORS。平台负责 TLS 终止，不能把 Node HTTP 端口直接暴露为没有 TLS 的公网服务。

部署后先检查公开 `/healthz`，并确认错误令牌和浏览器请求不能发信。再把网站的 `JUZI_EMAIL_RELAY_URL` 设置为实际 HTTPS 入口加 `/send`，配置同一生产令牌、独立学校登录 HMAC 和网站真实来源；全部准备好后才开启 `JUZI_EMAIL_ENABLED`。健康检查通过不代表 QQ 授权有效或邮件已送达，仍需由本人发起一次验证码并在收件箱完成实际登录验收。当前尚无已成功部署的公网中继地址。

HTTP 服务最多 100 个连接，单连接最多 100 次请求；请求头限制 8 KiB、请求体限制 2 KiB，读请求体 10 秒、连接空闲 20 秒超时。Bearer 验证在读取请求体之前执行，错误令牌不能通过缓慢上传占用完整请求体窗口。`SIGTERM`／`SIGINT` 最多等待约 18 秒完成在途操作；未完成的持久预留被记录为 `unknown` 后关闭 SQLite，再关闭连接并退出，留出 Render 30 秒终止窗口。未知请求不会自动重发。

请求体仅允许 `{requestId,email,code}`，限制 2 KiB；收件人必须是完整 `student.xjtlu.edu.cn` 域，验证码必须是 6 位数字，请求 ID 必须是 UUID。请求不能自定义发件人、正文、主题、附件或其他收件人。使用 Bearer 令牌；所有带 `Origin` 的浏览器请求均被拒绝，不提供 CORS。

SQLite 先持久预留发送额度，再发信。账本只包含请求 ID、邮箱 SHA-256、内容 HMAC、创建时间、状态和本站生成的确认 ID，不保存完整邮箱、验证码或 SMTP 凭据。不记录 SMTP 调试信息、响应或邮件内容。状态记录保留以支持重启后的幂等保护；不要删除账本来重复发送或重置额度。

同 ID 同内容成功重放会返回原确认 ID；冲突、失败、正在发送或结果未知的请求不会自动再次发信。启动时未完成的预留变为未知。令牌会域分离派生账本 HMAC 密钥，保留账本期间应保持稳定；旋转令牌后旧 ID 可能冲突，仍不会自动重发。账本加排他锁，第二个进程不能同时占用。

同时最多一个 SMTP 会话。12 秒未确认即向网站报告不确定，保留忙状态直到原 SMTP 调用真正结束；迟到的成功结果不会把未知请求变成可重放的成功。失败和未知结果均占日额度。新验证码要由用户重新申请，不自动重试旧请求。

仅当 SMTP 明确接受唯一目标、无拒绝目标且最终响应为 250，才向网站返回 `{id}`。这本身只代表发件服务接受邮件，仍需在学校邮箱检查实际送达与垃圾箱。此次单封收件已另行确认，不保证所有学校邮箱送达；错误、过期等验证码边界仍仅由 mock／受控测试覆盖。QQ 个人邮箱适合少量邮件，服务商可能另有限流，不能承诺具体送达率或批量发送能力。

Sites 运行环境不支持原始 TCP，不能直接运行本 SMTP 服务。生产使用上述独立 HTTPS Node 服务；本机地址不能作为公网 Sites 的生产中继。
