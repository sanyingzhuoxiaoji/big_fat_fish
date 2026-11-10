# 大肥鱼桌宠

Windows Live2D桌宠：GLM流式聊天、本机便签单向只读同步、关联任务的番茄钟和到点提醒。

## 本地启动

需要Node.js 24及npm。首次启动需要联网下载Electron与Live2D运行库；完成资源准备后，模型、待办和计时无需模型API即可运行。

```console
npm install --cache .local/npm-cache
npm run setup
npm start
```

也可双击 `启动大肥鱼.cmd`。模型默认读取本项目 `DeepSeek免费公皮/DeepSeek/大肥鱼.model3.json`，应用内可更换本地模型路径；大肥鱼原模型的动作和表情通过应用适配，不改原文件。

## 模型渲染兼容

使用 `pixi.js 8.16.0` + `@laplace.live/pixijs-live2d 0.6.1`（CubismWebFramework 5-r.5），配套官方 [Core 06](https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js)。`npm run setup` 会构建本地运行库、复制许可，并自动替换不兼容的旧 Core；运行时不访问 CDN。

鼻部黑块的颜色处理对照了[鲸语的逐画元乘算色/屏幕色修复](https://github.com/InariNGT-Ofiicial/jingyu-live2d-agent/blob/main/patch_renderer.py)。本项目由新框架处理这些颜色与遮罩，不修改模型、贴图或画元。不要把旧的 `sdk-web/cubismcore/` Core 与新框架混用。

## 模型大小与气泡

设置中的“模型大小”支持50%–150%即时调整，自动适配屏幕可用区域；“恢复默认”回到100%，比例重启后保留。气泡固定在模型上方的独立区域，长消息在气泡内滚动，不覆盖模型。



## 聊天

在设置填写标准 GLM API Key。新配置默认地址 `https://open.bigmodel.cn/api/paas/v4`、模型 `glm-5.3-flash`，依据[GLM-5.3-Flash 官方文档](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)。也可填写旗舰 `glm-5.3`；已有模型选择保留，不自动从免费模型切换。5.3 系列使用标准 API 余额按量计费，不消耗 Coding Plan 配额。API 地址和模型可修改。Key 默认仅保存在当前进程，勾选记住时使用 Electron safeStorage 加密保存；不会返回给界面或写入会话。

可以聊天，也可以说“看看我的待办”或“为这个任务开始专注”。当前便签仅单向读取：新增、改文字、完成任务和设置提醒都在本机便签中操作，聊天不能写回；工具失败时明确报错，不把口头答复当作执行成功。

5.3 系列始终开启思考，应用使用轻量推理档 `low`；思考内容只在工具调用上下文中原样回传，不进入聊天正文或气泡。旧模型拥塞可能返回 HTTP 429；应用呈现真实错误，不自动重试任务写入或悄悄切换模型。

## 联动 desktop_note

直接联动已安装的[桌面便签](https://github.com/sanyingzhuoxiaoji/desktop_note)，不要求新版桥接、不升级安装版，也不运行便签源码。默认读取并监听 `%APPDATA%/desktop-sticky-note/sticky-note-data.json`；便签中的任务、状态和已有提醒变化后自动刷新。

“打开便签”从桌面或开始菜单快捷方式查找本机EXE；找不到时，在设置中选择或填写便签程序。便签数据目录也可配置。待办页只读展示，点击未完成任务可选择专注；修改与提醒仍在便签里设置。

按用户要求，原双向工具、编辑界面、源码启动与写入入口注释保留，`note-client.cjs`保留但不加载，当前不会自动切回双向模式。恢复双向需另外实施并验证，不是设置开关。

## 专注与提醒

选择待办后开始番茄钟，或直接自由专注。支持暂停、继续、结束和休息。关闭面板不中断计时；退出后重新启动按原截止时刻恢复，暂停态则不消耗剩余时间。休眠按墙钟经过时间处理，完成一轮不自动把任务标记完成。

待办提醒仍由安装版便签独立调度；大肥鱼观察便签写入的“已提醒”状态变化显示气泡，不启动第二套闹钟，也不在启动时重播历史提醒。便签需在后台运行以调度本地通知。聊天API不可用不影响本地读取和计时。

鼠标穿透后从托盘恢复交互；通过托盘退出应用。

## 数据与验收

桌宠运行数据保存在项目 `.local/`，不提交Git；包含配置、会话、专注状态和本机加密Key（如选择记住）。请勿把这个目录分享给他人。

隔离验收启动参数：

```console
npm start -- --data-dir=D:/project/big_fat_fish/.local/acceptance/fish --note-data-dir=D:/project/big_fat_fish/.local/acceptance/notes
```

`--note-data-dir`或`DESKTOP_NOTE_DATA_DIR`只改变桌宠读取目录，隔离验收不写真实待办，也不修改安装版自己的数据路径。

```console
npm test
```

测试临时数据限制在项目 `.local/tmp`。旧双向桥接模块的存储测试仍需关联目录 `../便签`，当前安装版联动不依赖该源码。详细实施和已实际执行的验证见 [实施计划](docs/IMPLEMENTATION_PLAN.md)、[进度与验证记录](docs/PROGRESS.md)。

## 许可与资源

应用代码许可与第三方声明见 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。Live2D模型和Cubism Core不是应用代码许可的一部分。模型不得擅自再分发，GitHub仓库不包含模型；请从作者原始发布渠道自行获取并导入。

模型：DeepSeek-chan（大肥鱼）；原画及拆分：神宫凉子；Live2D建模：霓虹猫_NeonNeko；来源：神宫凉子免费配布模型。使用时保留原模型使用须知；公开内容按须知署名。Cubism Core从官方获取并按官方许可使用。
