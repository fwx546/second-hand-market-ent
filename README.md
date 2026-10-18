# 橘子集 · 校园闲置演示

面向西交利物浦大学的校园二手交易网页，覆盖 SIP 校区和太仓校区，主要展示小电器、电瓶车与生活用品。包含首页、商品详情、发布商品和个人中心，并适配桌面与手机。

这是静态交互演示：商品、卖家、价格和联系方式均为虚构示例。用户先联系卖家，再约定线下面交；本版没有真实登录、聊天、支付、订单或共享后端。收藏、模拟发布和上传照片仅保存在当前浏览器的 IndexedDB 中，不会同步给其他同学；清除浏览器站点数据会丢失这些记录。

## 本地启动

需要 Node.js 22 或更高版本及随附的 npm；项目没有第三方运行依赖，无须执行 `npm install`。

```powershell
git clone https://github.com/fwx546/second-hand-market-ent.git
cd second-hand-market-ent
npm run dev
```

打开 <http://127.0.0.1:4173/>。请从仓库根目录运行命令，通过 HTTP 服务预览，不要直接双击 HTML 文件。按 `Ctrl+C` 停止服务。端口被占用时，可在 PowerShell 中先运行 `$env:JUZI_PORT = '4174'` 再启动。

```powershell
npm run check
```

检查后按 [QA.md](QA.md) 验证页面布局、搜索筛选、收藏、发布与下架；现有验收记录包含未完成的验证项，不代表未来修改自动通过。

## 修改入口

**`dist/` 是手写源码，也是发布目录，不是可以删除后重新生成的构建产物。** 当前无前端编译步骤，不要清理、覆盖或加入忽略列表。

| 修改内容 | 文件或目录 |
| --- | --- |
| 页面渲染、哈希路由、搜索筛选、发布和本地存储 | `dist/app.js` |
| 桌面与手机布局、配色和样式 | `dist/styles.css` |
| 示例商品、分类和卖家信息 | `dist/data.js` |
| HTML 入口、标题和元信息 | `dist/index.html` |
| 商品照片、插画及来源记录 | `dist/assets/` |
| 可编辑 SVG 设计稿与生成说明 | `design/`、`scripts/design-export.mjs` |
| 本地服务和自动检查 | `scripts/serve.mjs`、`scripts/check.mjs` |
| 已有 Sites 项目关联 | `.openai/hosting.json` |

仓库采用根目录单仓库结构。开发命令、相对路径和部署清单都以本目录为根；迁移备份不参与开发或部署。

## 设计与素材

[在线 Figma 文件](https://www.figma.com/design/aj8JjrnlIaFq9QbDJWCq7r?node-id=202-697)包含八个原生 Frame 画板（四个页面各含桌面、手机版）和组件展示，文字与布局图形可独立编辑。尚未建立 Auto Layout 或原生组件实例；组件展示不等同于可复用的 Figma 组件库。详见 [design/README.md](design/README.md)。

暖色电商视觉参考 Magenest 的 [Monito 模板](https://www.behance.net/gallery/155074809/FREE-TEMPLATE-eCommerce-Website-Monito-Pets-Store)，按设计来源记录保留 CC BY 4.0 署名及修改说明。商品图片的作者、来源和许可逐项记录于 [素材清单](dist/assets/SOURCES.md)。新增或替换素材时同步更新记录，不要将模板或照片来源视为本项目原创。

SVG 生成脚本有独立的布局定义；修改网站的 HTML/CSS/JavaScript 不会自动同步 Figma 或 SVG 设计稿。

## 访问与部署

已有 Sites 网址：<https://juzi-campus-market.open-bloom-6517.chatgpt.site>。已记录部署成功及后台 `active/public` 状态，但当前测试网络触发 Cloudflare 拦截，公开访问阻断尚未解决，不能承诺所有访客均可打开。

**推送 GitHub 不会自动发布到 Sites。** 更新网站需要通过 Sites 插件发布到已有项目；普通静态托管则发布完整 `dist/` 内容。步骤及限制见 [DEPLOYMENT.md](DEPLOYMENT.md)，分支和 PR 协作方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。
