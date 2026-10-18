# 协作开发

仓库地址：<https://github.com/fwx546/second-hand-market-ent.git>。在仓库根目录开发和运行命令；`dist/` 是手写源码，不可作为构建缓存删除。

有写入权限的协作者可以推送自己的分支并提交 PR；没有写入权限时，请联系仓库所有者获取协作权限，或在允许 Fork 的情况下先 Fork 再提交 PR。克隆权限与写入权限是分开的。

## 开始一次修改

需要 Node.js 22+ 和 npm，无第三方依赖需要安装。

```powershell
git clone https://github.com/fwx546/second-hand-market-ent.git
cd second-hand-market-ent
git switch main
git pull --ff-only origin main
git switch -c feat/describe-your-change
npm run dev
```

打开 <http://127.0.0.1:4173/>。修复可使用 `fix/` 分支前缀，文档修改可使用 `docs/`。已有本地仓库时从更新 `main` 开始，不要在有未保存修改的工作区强行切换或清理文件。

## 修改约定

- 页面交互修改 `dist/app.js`，样式修改 `dist/styles.css`，示例商品修改 `dist/data.js`，图片放入 `dist/assets/`；完整映射见 [README.md](README.md)。
- 保持演示数据明确标识，联系信息使用虚构内容。当前没有登录或后端，所有发布、收藏及照片只保存在当前浏览器中；不要把浏览器内的“我的发布”误认为真实账号权限。
- 新增或替换图片时更新 `dist/assets/SOURCES.md`，保留作者、来源和许可记录。设计参考与署名见 `design/README.md`。
- 网站和设计稿分别维护。SVG 生成器有独立布局，修改 CSS 不会自动更新 Figma；涉及布局变更时，在 PR 中说明设计稿是否同步。
- 不提交密码、访问令牌、API Key、登录 Cookie、环境变量密钥或私钥。`.openai/hosting.json` 中的项目关联不等于凭据，不要擅自改成新项目。
- 不提交本地工具、迁移备份、日志或旧部署归档；不要将嵌套 Git 仓库重新加入项目。

## 验证与提交

```powershell
npm run check
git diff --check
git status --short
```

自动检查覆盖示例数据、图片文件、本地数据约定与部署清单。涉及交互或样式时，还应在 1440px、390px、320px 视口检查相关页面，验证搜索筛选、收藏刷新、发布预览、编辑及下架。图片上传相关改动需人工测试真实文件选择。按影响范围验证，不必为了单纯文档修改重跑全部浏览器流程。

浏览器已有 IndexedDB 数据可能遮蔽 `data.js` 的修改；需要查看初始示例时使用站点内“重置演示”。这会清除该浏览器中的模拟发布和收藏，请先确认没有需要保留的演示记录。

```powershell
git add <本次修改的文件>
git commit -m "说明本次修改的行为"
git push -u origin feat/describe-your-change
```

在 GitHub 创建目标为 `main` 的 Pull Request，写清具体变化、验证结果、截图及尚未验证的事项。审查通过后合并；后续修改仍通过独立分支和 PR，不要强制推送共享分支。

GitHub 合并或推送只更新源码，不会自动更新 Sites。需要发布时，按 [DEPLOYMENT.md](DEPLOYMENT.md) 单独更新已有站点；不要把源码合并等同于线上已生效或已解决公开访问限制。
