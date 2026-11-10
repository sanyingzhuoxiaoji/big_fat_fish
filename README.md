# 大肥鱼桌宠

Windows Live2D桌宠：GLM流式聊天、desktop_note双向待办、关联任务的番茄钟和到点提醒。

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


## 聊天

在设置填写标准 GLM API Key。新配置默认地址 `https://open.bigmodel.cn/api/paas/v4`、模型 `glm-5.3-flash`，依据[GLM-5.3-Flash 官方文档](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)。也可填写旗舰 `glm-5.3`；已有模型选择保留，不自动从免费模型切换。5.3 系列使用标准 API 余额按量计费，不消耗 Coding Plan 配额。API 地址和模型可修改。Key 默认仅保存在当前进程，勾选记住时使用 Electron safeStorage 加密保存；不会返回给界面或写入会话。

可以聊天，也可以说“帮我记下写报告，明天下午三点提醒我”。任务操作由工具真实提交；如果API或便签连接失败，应用明确报错，不会把口头答复当作保存成功。含糊时间应先澄清。设置了提醒的任务以实际日期时间为准。

5.3 系列始终开启思考，应用使用轻量推理档 `low`；思考内容只在工具调用上下文中原样回传，不进入聊天正文或气泡。旧模型拥塞可能返回 HTTP 429；应用呈现真实错误，不自动重试任务写入或悄悄切换模型。

## 联动 desktop_note

本项目要求带本机桥接接口的更新版 [desktop_note](https://github.com/sanyingzhuoxiaoji/desktop_note)。当前授权修改的本地项目为 `D:/project/便签`；换机器后在设置里填写便签源码所在目录，点击“启动便签”或“连接便签”。桌宠可使用自己的Electron运行便签源码，无需再给便签安装一份Electron。

如果已经运行不带桥接接口的旧安装版，请先从其托盘真正退出（关闭窗口只是隐藏），再启动更新后的联动版；同一便签数据目录只允许一个实例。

便签保持待办唯一写入者，桌宠通过仅监听127.0.0.1、带令牌的接口修改任务。任一侧新增、修改、完成都会同步；便签窗口可隐藏到托盘。数据仍归便签，桌宠不直接写便签JSON。

## 专注与提醒

选择待办后开始番茄钟，或直接自由专注。支持暂停、继续、结束和休息。关闭面板不中断计时；退出后重新启动按原截止时刻恢复，暂停态则不消耗剩余时间。休眠按墙钟经过时间处理，完成一轮不自动把任务标记完成。

待办提醒由便签统一调度：便签发系统通知，大肥鱼显示气泡与动作。必须有便签进程在后台运行；关机期间无法即时提醒，启动后补发过期提醒。聊天API不可用不影响已经安排的本地提醒和计时。

鼠标穿透后从托盘恢复交互；通过托盘退出应用。

## 数据与验收

桌宠运行数据保存在项目 `.local/`，不提交Git；包含配置、会话、专注状态和本机加密Key（如选择记住）。请勿把这个目录分享给他人。

隔离验收启动参数：

```console
npm start -- --data-dir=D:/project/big_fat_fish/.local/acceptance/fish --note-data-dir=D:/project/big_fat_fish/.local/acceptance/notes
```

便签支持 `DESKTOP_NOTE_DATA_DIR` 覆盖数据目录和 `--background` 隐藏启动；联动测试不读写真实待办。

```console
npm test
```

测试临时数据限制在项目 `.local/tmp`。便签存储相关测试需要关联目录 `../便签`；详细实施和已实际执行的验证见 [实施计划](docs/IMPLEMENTATION_PLAN.md)、[进度与验证记录](docs/PROGRESS.md)。

## 许可与资源

应用代码许可与第三方声明见 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。Live2D模型和Cubism Core不是应用代码许可的一部分。模型不得擅自再分发，GitHub仓库不包含模型；请从作者原始发布渠道自行获取并导入。

模型：DeepSeek-chan（大肥鱼）；原画及拆分：神宫凉子；Live2D建模：霓虹猫_NeonNeko；来源：神宫凉子免费配布模型。使用时保留原模型使用须知；公开内容按须知署名。Cubism Core从官方获取并按官方许可使用。
