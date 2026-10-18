# 配置手机号与微信登录

本站保留 ChatGPT 登录，并提供可配置的外部 OIDC 登录接入。没有认证服务账号时，手机号和微信入口默认显示“尚未开通”。本站不接收手机验证码、不发送短信，也不模拟真实微信授权。真实服务尚未开通，短信发送、微信授权以及 Sites 上的真实回调仍待验收。

外部登录使用 **Authorization Code + PKCE（S256）**，通过一个入口前往服务商托管的登录页，由用户在那里选择手机号或微信。下面以 Authing 为例；其他服务必须提供兼容的 OIDC Discovery、授权、令牌与 JWKS 端点。

## 1. 准备认证服务

由维护者注册 Authing 账号、创建用户池和 OIDC 应用。在应用控制台记录实际的 Issuer、Client ID；需要密钥认证时再获取 Client Secret。不要把密钥发到聊天、GitHub 或截图中。

在应用协议配置中：

- 开启授权码模式，返回类型选 `code`，支持 S256 PKCE。
- **ID Token 签名算法选 RS256。本站不支持 HS256。**
- Token 端点认证方式与本站的 `JUZI_AUTH_TOKEN_AUTH_METHOD` 保持一致：`none`、`client_secret_post` 或 `client_secret_basic`。使用后两者时需要服务端 Client Secret；本站默认 `none`。
- 允许请求 `openid`。本站只请求此 scope，不需要手机号、邮箱或微信档案字段。

Authing 的 Issuer 通常形如 `https://<应用域名>.authing.cn/oidc`，以控制台显示为准。本站从 `{issuer}/.well-known/openid-configuration` 读取真实端点，不把文档示例域名作为运行配置。参见 [官方 PKCE 与 Discovery 指南](https://docs.authing.cn/v2/apn/more-oidc-tests/type2.html)、[Token 端点认证方式](https://docs.authing.cn/v2/reference/sdk-for-node/authentication/StandardProtocol.html)和 [RS256 / JWKS 验证说明](https://docs.authing.cn/v2/guides/faqs/how-to-validate-user-token.html)。

## 2. 配置精确回调地址

将实际环境的以下地址加入应用的登录回调白名单：

| 环境 | `JUZI_AUTH_ORIGIN` | 登录回调地址 |
| --- | --- | --- |
| 默认本地预览 | `http://localhost:5173` | `http://localhost:5173/api/auth/callback` |
| 本地 4174 端口 | `http://localhost:4174` | `http://localhost:4174/api/auth/callback` |
| 当前生产站点 | `https://juzi-campus-market.open-bloom-6517.chatgpt.site` | `https://juzi-campus-market.open-bloom-6517.chatgpt.site/api/auth/callback` |

Origin 不含末尾斜线。访问时的协议、主机和端口必须一致；`localhost` 与 `127.0.0.1` 不能混用。**使用 `/api/auth/callback`，不要替换或配置 Sites 平台自己的 `/callback`。** 更换域名或端口后，要同步修改服务商白名单和本站 Origin。

## 3. 在托管登录页开通登录方式

在 Authing 应用的“登录控制”中启用“手机号 + 验证码”，并创建、添加适合网页场景的微信社会化身份源。资质材料、短信签名与模板、微信应用授权、费用及审核由维护者在对应服务商控制台办理，以实际审核结果为准。本站的配置开关不会替你开通这些服务。

两种方式在同一个托管登录页展示。不要给本站添加未经服务商文档确认的登录方式选择参数。配置方法见 [Authing 托管登录控制](https://docs.authing.cn/v2/guides/app-new/create-app/login-control.html)。

## 4. 注入本站配置

本地在仓库根目录复制样例：

```powershell
Copy-Item -LiteralPath .env.example -Destination .env.local
```

编辑 `.env.local`，填写实际值：

| 变量 | 内容 |
| --- | --- |
| `JUZI_AUTH_ISSUER` | 服务商控制台显示的 OIDC Issuer |
| `JUZI_AUTH_CLIENT_ID` | OIDC 应用 Client ID |
| `JUZI_AUTH_TOKEN_AUTH_METHOD` | 与控制台一致的 `none` / `client_secret_post` / `client_secret_basic` |
| `JUZI_AUTH_CLIENT_SECRET` | 仅后两种认证方式需要，作为服务端密钥保存 |
| `JUZI_AUTH_ORIGIN` | 上表中实际使用的站点 Origin |
| `JUZI_AUTH_PHONE_ENABLED` | 托管页手机号登录已开通后设为 `true` |
| `JUZI_AUTH_WECHAT_ENABLED` | 托管页微信登录已开通后设为 `true` |

本地 Cloudflare 开发环境会读取 `.env.local` 并提供给 Worker；如果存在 `.dev.vars`，它会优先于 `.env*`，不要同时维护两套不同配置。详见 [Cloudflare 本地环境变量说明](https://developers.cloudflare.com/workers/local-development/environment-variables/)。

生产通过具有项目权限的 Sites 环境设置工具或界面注入这些变量，密钥使用服务端秘密值；不要写进源码、`public/`、构建产物或 `.openai/hosting.json`，也不要添加 `VITE_` / `NEXT_PUBLIC_` 前缀。`.env.local` 已被 Git 忽略，只有空白的 `.env.example` 可提交。

首次使用或更新迁移后运行：

```powershell
npm run build
npm run db:migrate
npm run dev
```

使用 4174 端口时将最后一行改为 `npm run dev -- --port 4174`。本地迁移仅应用于本地 D1；生产新增迁移由 Sites 发布流程应用。迁移不导入真实账号或演示商品。修改配置后重启开发服务。

## 5. 实际验收

先确认登录页显示正确开通状态；未配置时应显示“尚未开通”，后端应拒绝发起外部授权。开通后使用真实账号依次验证：

1. 从本站进入托管页，分别完成大陆手机号验证码和微信授权，再回到本站。
2. 登录后发布、收藏和读取联系方式；刷新后会话保持，同一账号在另一个浏览器能看到自己的记录。
3. 换另一个账号，确认不能编辑、下架对方商品，不能读取对方未发布照片。
4. 退出登录后，确认不能继续读取联系方式或管理商品。异常、过期或重复回调不能获得登录状态。

站内会话固定 7 天，到期需重新授权，不按访问时间滑动延长；每次授权流程有效 10 分钟且只能完成一次。会话 Cookie 使用 `HttpOnly` 和 `SameSite=Lax`。本站退出会清除外部本站会话，再走 Sites 平台登出以清除 ChatGPT 身份；**不主动注销认证服务商的 SSO 会话**，下次授权可能无需重新输入验证码。

外部用户按 Issuer + `sub` 稳定关联站内记录，不会凭手机号、邮箱或昵称自动合并旧 ChatGPT 账号。手机号和微信如需共用记录，应在同一认证服务内绑定到同一用户；切换到未绑定的身份可能进入另一个账号。本站不验证学生身份。

本站不保存外部 ID Token、Access Token、登录手机号或微信档案。用户在商品发布表单中另行填写的交易联系方式仍按 [PRIVACY.md](PRIVACY.md) 保存和展示。

服务商的真实账号、短信和微信尚未配置时，协议测试不代表上述真实链路已通过。外部登录也不保证解除现有 Cloudflare 访问拦截；生产可访问性、Cookie 与回调兼容性需分别验收并记录。
