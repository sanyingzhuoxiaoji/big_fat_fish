# 实施与验证记录

## 上一轮已交付基线

| 阶段 | 状态 | 已验证证据 | 剩余问题 |
|---|---|---|---|
| 方案落盘 | 完成 | `docs/IMPLEMENTATION_PLAN.md` | 无 |
| 1 模型与窗口 | 通过 | Pixi8 + Laplace0.6.1 + Core06实际渲染，鼻部黑块消失；拖动−30px、穿透开关、点击恢复面板、表情资源200 | 未做安装包分发测试 |
| 2 双向待办 | 通过 | 便签UI新增→GLM查询；GLM增改完成→便签UI及归档；最终同一ID两端均done | 无已知阻塞 |
| 3 GLM与工具 | 通过 | 5.3-Flash五个真实工具成功，面板收到start/tool/delta/done，滚动到最新回复；业务测试27/27 | 5.3标准API按量计费，已有模型选择不自动更改 |
| 4 番茄钟与提醒 | 通过 | 绑定任务计时、暂停/继续/关闭面板、应用重启；清Key后计时与到点提醒仍正常，任务未被自动完成 | 未实际触发Windows系统休眠 |
| 5 完整验收 | 通过 | 同一任务完成真实GLM→便签UI→绑定番茄→提醒→UI完成→两端done全链路；文档与发布文件齐全 | 本项目交付源码启动方式，未声称完成安装包构建 |

## 安全与范围

- 临时API Key不写入本文件或源码。
- 不修改模型原文件；不上传模型与运行数据。
- 验收使用项目内隔离数据，不改用户真实便签数据。
- 无Git仓库的纯模型目录，按用户要求直接在当前项目实现，不创建外部worktree。

## GitHub

私有桌宠仓库：https://github.com/sanyingzhuoxiaoji/big_fat_fish 。初始业务核心与计划提交为7b4e29b；本次完整实现、兼容修复和验收记录随main提交发布，最新提交号见交付回执及仓库main。关联便签桥接已发布至 https://github.com/sanyingzhuoxiaoji/desktop_note ，提交c434a48（起始09dc546）。模型、Core、Key、会话、截图和.local运行数据不上传。

## 验证日志

- 环境检查：`node --version && npm --version && git --version && python --version` 成功。
- 已阅读官方文档：https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash 。使用临时Key真实POST到官方通用chat/completions，HTTP200、模型glm-4.7-flash、回复“大肥鱼连接成功”；未保存Key。
- 测试先行：缺少待实现模块的首次MODULE_NOT_FOUND为预期红灯，不作为运行验收。
- 发现并修复实际计时缺陷：可选onComplete缺省时到期抛错；另补运行中逐秒状态推送。修复后 `node scripts/test.cjs tests/pomodoro.test.cjs tests/pomodoro-boundaries.test.cjs tests/note-client.test.cjs`：7通过、0失败。
- 上述是业务模块验证，不代表模型窗口或完整应用已经通过验收。
- 核心审查发现并复现两条实际路径：迟到HTTP回执覆盖更新SSE快照；到期后暂停冻结0秒并超算专注。分别加入回归用例并修复。最新核心检查 `node scripts/test.cjs tests/pomodoro.test.cjs tests/pomodoro-boundaries.test.cjs tests/note-client.test.cjs`：9通过、0失败。
- 流式聊天/任务工具与公开状态凭据隔离首轮检查：9通过、0失败。另发现会话读写失败被吞、SSE上游错误被忽略，已增加3个失败用例，正在修复；尚未认定聊天阶段通过。
- 聊天持久化与上游流式错误传播已修复；`node scripts/test.cjs tests/chat.test.cjs tests/chat-errors.test.cjs tests/chat-persistence.test.cjs tests/app-service.test.cjs`：12通过、0失败。
- 首次真实ChatService流式验证：GLM返回HTTP429“该模型当前访问量过大，请您稍后再试”。没有收到有效模型回复，未执行待办工具；记录为未通过，不以本地测试替代真实API验收。继续推进其他阶段。
- 业务核心和计划已推送私有仓库，提交 `7b4e29b`。模型、临时Key及.local运行数据未上传。
- 便签存储提前检查：旧数据保留通过；全新数据目录初始化出现items未定义，已将实际失败交实现任务修复。
- 恢复执行：用户报告鼻部黑块并提供乘算色/新渲染库线索；不改模型素材，撤回先前仅凭整体截图作出的“渲染正常”结论。
- 已核对官方GLM 5.3文档：5.3仅支持thinking enabled；交错思考+工具必须回传reasoning_content。新默认glm-5.3-flash，保留已有模型配置，不静默触发付费升级。
- 临时Key仅在父任务内存调用通用API：glm-5.3-flash、thinking enabled、reasoning_effort low，HTTP200，回复“大肥鱼连接成功”。不以单次基础调用代替完整工具验收。
- 协议回归测试先后捕获两次HTTP400（禁用thinking、丢失工具推理上下文）；修复后全部业务测试27通过、0失败。
- 本次通过实际便签界面的composer输入并回车，新增“便签界面双向验收”成功。验收仍使用隔离数据。
- 真实GLM工具验收：create_task保存“大肥鱼全流程验收”；list_tasks取真实ID；update_task改为“大肥鱼全流程验收（已修改）”；start_focus绑定同一ID启动12秒专注；complete_task仅完成用户明确指定的另一条验收任务。各工具成功回执均来自实际便签存储，模型最终回复随后流式到达。
- 便签真实UI已显示GLM创建/修改的任务，归档区也显示GLM完成的任务。重建业务服务后12秒计时恢复为workEnd且今日只计1轮，绑定任务仍为todo，未自动完成。
- 临时Key未出现在真实验收的settings.json/chat.json/focus.json。主进程穿透接口统一为可选enabled/hovered；显式便签数据目录先绝对化，未指定时不再覆盖便签实际默认数据目录。
- 修正关联便签的build.files，打包时包含task-store.cjs和pet-bridge.cjs；不修改已冻结的便签运行时代码。
- 主代理直接对照鲸语 `patch_renderer.py`、`vendor-sources.json`、`web/app.mjs`：旧栈的鼻部问题是未应用逐画元乘算色/屏幕色；鲸语以shader回补，本项目迁移到官方新框架原生处理，不改原贴图。
- 渲染匹配修复：旧官方`/sdk-web/cubismcore/`是legacy Core05.01.0000，不能与新框架的一参数csmGetMocVersion API混用。固定新官方`/sdk-web/core/06/`（06.00.0001），setup自动识别并替换旧Core。
- 实际加载还验证并修复：Pixi CSP适配模块（不开放JS unsafe-eval）、中文应用名进入UA导致自定义协议重载ByteString失败、纹理blob Worker等待（改用引擎公开的DOM图片解码选项）。新渲染管线显式注册，表情按单一反馈状态切换。
- 最终`npm run setup`成功：本地bundle 1,150,492字节；Core06匹配且无运行时CDN请求。最终模型控制台无warning/error，加载/脸红表情资源均返回200。
- 真机窗口拖动−30px后还原；开启穿透后点击模型打开面板成功。截图：`.local/acceptance/pet-cubism5.png`、`pet-expression-final.png`、`pet-reminder-final.png`。
- 面板验收修复了开始专注按钮误把MouseEvent当taskId的问题；启动工作30秒/6秒回合、休息、暂停继续均正常。计时state推送后未提交的设置草稿仍保留，隐藏面板不中断。
- 应用实际退出重启：剩余时间从59,982ms恢复为31,747ms（未重置为60秒），绑定任务仍todo，完成计数未重复。Key未记住，重启后hasApiKey=false。
- 最终完整链路的任务ID为mwahdq57vh1j6：GLM创建/修改、便签UI可见、绑定专注结束仍todo、便签到点推送气泡与表情、面板点击完成后两端均done。显式修改提醒时间会重新武装，完成任务清除提醒。
- 本地计时/提醒验收期间已通过UI清除Key（hasApiKey=false）；实际等待仍收到“该做这件事啦”气泡。随后实际UI验证缺Key错误和清除会话（messages=0）。
- 最终四个运行脚本`node --check`均通过。业务套件27/27通过的代码未再改变；UI使用实际Electron操作验收，没有添加复制/转发断言或模拟界面测试。

## 本轮阶段A：气泡与模型缩放

- 已获用户确认执行单向只读联动计划；双向实现先注释保留，不删除，各阶段验收后立即提交推送。
- 实际Electron窗口通过50%、100%、150%显示和长消息检查：气泡底边分别119/114/114px，模型画布顶边始终128px，长文本仅在气泡内滚动。
- 验收发现缩小窗口时canvas固有宽度撑开Grid列；固定为`minmax(0,1fr)`后，模型画布随窗口收缩，50%时宽280px，150%时宽570px。已检查屏幕右下边界显示和两张实际截图。
- 设置滑块即时生效；退出并实际重启后125%恢复成功，点击恢复默认得到100%。两个窗口无未捕获错误。
- `node scripts/test.cjs tests/window-layout.test.cjs`：2通过、0失败；main.cjs、panel.js、pet.js语法检查成功。截图保留在`.local/acceptance/layout-50.png`及`layout-150.png`，不上传。

