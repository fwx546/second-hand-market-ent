# 橘子集 · 可编辑页面布局设计包

面向 **西交利物浦大学**，校区采用 **SIP 校区** 与 **太仓校区**。图书馆入口、公共服务区等面交信息均为虚构的通用演示地点，不代表学校官方指定位置。

本目录是 **可导入 Figma 的 SVG 设计稿**。已完成 Figma 登录、复制 Monito 模板，并在 [橘子集在线 Figma 文件](https://www.figma.com/design/aj8JjrnlIaFq9QbDJWCq7r?node-id=202-697) 的 `202-697` 页面导入八个页面组及组件展示，文字和布局图形可独立编辑。尚未建立 Figma 原生组件实例、Auto Layout、变量或交互原型连接。照片使用内嵌的独立图片层，兼容稿采用 SVG 1.1 的 `xlink:href`，以便重导入时识别图片；页面没有使用整页截图。

## 画板

**一次导入所有设计：** 将 `juzi-design-board.svg` 拖入 Figma；八个页面画板按“桌面在左、手机在右”分四行排列，最后一行是组件。各画板内部对象与裁切路径 ID 都已加独立前缀，可避免合并后的引用冲突。也可使用下面的单页文件分别导入。

**通过剪贴板导入：** 优先使用 `juzi-design-board-compact.svg`，保持相同的可编辑文字、形状和布局，仅将照片缩小至最长边 180px、JPEG 质量 65，降低 Figma 粘贴负担。完整版本保留较清晰的照片图层。压缩不会修改 `dist/assets/` 中的网站原图。

| 页面 | 桌面（1440px） | 手机（390px） |
| --- | --- | --- |
| 首页 | 01-home-desktop.svg | 01-home-mobile.svg |
| 商品详情 | 02-detail-desktop.svg | 02-detail-mobile.svg |
| 发布商品 | 03-publish-desktop.svg | 03-publish-mobile.svg |
| 个人中心 | 04-profile-desktop.svg | 04-profile-mobile.svg |

`components.svg` 包含颜色、文字层级、按钮、标签、图标、商品卡片、表单和联系弹窗。个人中心采用“已发布两件商品”的示例状态；网站首次访问时会显示空状态，模拟发布后可进入同类管理状态。

SVG 是依据本项目实际的 HTML/CSS/JavaScript 界面重新组织的静态布局设计，适合继续编辑与评审，不包含 Figma Auto Layout、原生组件实例、变量或交互原型连接。中文字体使用 Microsoft YaHei / PingFang SC / Noto Sans CJK SC；编辑环境缺少对应字体时可统一替换。

## 设计来源与署名

橘子集的橘子角色、校园文案、商品数据、图形与页面组合为本项目原创设计。暖色电商视觉和圆角卡片布局参考了 **Monito – eCommerce Website**，原作品及作者署名见 [Figma Community 文件](https://www.figma.com/community/file/1164046882633361201) 和 [作者展示页](https://www.behance.net/gallery/155074809/FREE-TEMPLATE-eCommerce-Website-Monito-Pets-Store)。参考模板采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)；本项目改为校园二手交易内容，采用橙色、奶油白、薄荷绿配色并重新绘制角色与布局。在线 Figma 文件保留所复制的模板；本目录 SVG 是本项目重新生成的橘子集设计，不是该模板原生图层的导出。

商品照片的逐项作者、来源与许可证说明见 [assets/SOURCES.md](../dist/assets/SOURCES.md)。商品、价格、卖家、联系方式与车辆参数均为虚构演示，不代表素材照片中实物的真实信息。

## 重新生成

在项目根目录使用 Node.js 运行：

```powershell
node scripts/design-export.mjs
powershell -ExecutionPolicy Bypass -File scripts/design-compact.ps1
```

脚本读取 `dist/data.js` 和 `dist/assets/`，输出 8 张页面 SVG、1 张组件 SVG 及 1 张完整设计看板；不修改网站实现。
