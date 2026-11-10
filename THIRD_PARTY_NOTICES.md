# 第三方组件与许可说明（THIRD PARTY NOTICES）

本项目桌宠渲染端使用的第三方运行库及其许可。许可原文随库保存在 `vendor/licenses/`（由 `npm run setup` 从锁定依赖复制），本文件为摘要；如有出入以许可原文为准。

## 运行时（打包进 vendor/runtime.bundle.js）

### pixi.js 8.16.0
- 来源：https://www.npmjs.com/package/pixi.js / https://github.com/pixijs/pixijs
- 许可：MIT（原文：`vendor/licenses/pixi.js-LICENSE`）

### @laplace.live/pixijs-live2d 0.6.1
- 来源：https://www.npmjs.com/package/@laplace.live/pixijs-live2d
- 仓库：https://github.com/laplace-live/persona（`packages/pixijs-live2d`；fork 自 untitled-pixi-live2d-engine v1.3.5，系 pixi-live2d-display 的 PixiJS v8 延续线）
- 许可：MIT（原文：`vendor/licenses/pixijs-live2d-LICENSE`）
- 该引擎内以原始镜像方式包含 Live2D CubismWebFramework `5-r.5`，遵循 Live2D 开源软件许可（Live2D Open Software License），原文：`vendor/licenses/pixijs-live2d-cubism-framework-LICENSE.md`；https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html

## 运行时（单独加载，不入 Git 仓库）

### Live2D Cubism Core（vendor/live2dcubismcore.min.js）
- 来源：Cubism SDK for Web 5-r.5 配套 Core 06（实测 06.00.0001），https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js ；官方下载与许可说明：https://www.live2d.com/en/sdk/download/web/
- 许可：Live2D 专有软件许可（Live2D Proprietary Software License），https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- 该文件按官方协议属于可再分发的"Redistributable Code"，本项目不修改其内容；按本项目资源分发约定不纳入 Git 仓库（.gitignore），由 `npm run setup` 从官方地址下载。
- 商用达到营收门槛时还需 Live2D Cubism SDK Release License，发布前请自行确认条款。

## 应用外壳与构建工具

- Electron 43.7.9：运行时应用外壳，遵循 MIT；若分发完整应用，随其分发的 Chromium/Node 及其他组件各自携带许可。
- esbuild 0.28.2（MIT）：仅用于 `npm run setup` 时本地打包上述运行库，不属于浏览器端运行库。

## 模型素材

- 「大肥鱼」Live2D 模型（`DeepSeek免费公皮/` 目录）非本项目再分发物：原画 神宫凉子，建模 霓虹猫_NeonNeko。模型文件不进入 Git 仓库，相关授权见 PRODUCT.md 与仓库 README。
