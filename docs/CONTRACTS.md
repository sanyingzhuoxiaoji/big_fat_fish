# 模块集成契约

所有模块CommonJS，UI为浏览器JS。父任务负责 `src/app-service.cjs`、`src/services/note-client.cjs`、集成验收与总体文档；实现子任务按文件所有权工作，不修改其他模块。

## Electron外壳与业务服务

`createAppService({dataDir,noteDataDir,onState,onChat,onPet,notify,encryptSecret,decryptSecret})` 从 `src/app-service.cjs` 导出；返回 `{init(), state(), handle(method,payload), close()}`。onState发送完整可公开状态；onChat发送聊天增量事件；onPet发送 `{type:'expression'|'bubble'|'motion',name?,text?}`。notify接收 `{title,body}`。

主进程IPC `fish:action` `(method,payload)` 白名单转交handle，窗口操作自己处理。preload暴露 `window.fish`：`action(method,payload)`、`onState(fn)`、`onChat(fn)`、`onPet(fn)`（订阅均返回取消函数）。IPC推送 `fish:state`/`fish:chat`/`fish:pet`。

业务action：`getState`, `saveSettings`, `sendMessage`({text}), `clearChat`, `createTask`({text,remindAt?}), `updateTask`({id,patch}), `startFocus`({taskId?,text?,workMinutes?,restMinutes?}), `pauseFocus`, `resumeFocus`, `stopFocus`, `startRest`, `connectNotes`, `openNotes`。

窗口action由main负责：`showPanel`, `hidePanel`, `setMouseThrough`({enabled?,hovered?})（仅传hovered不更改用户开关，返回{enabled,mouseThrough,ignore}）, `movePet`({dx,dy}), `setPetScale`({scale:0.5..1.5}), `quit`, `selectModel`, `getShellInfo`。getShellInfo包含petScale、bubbleHeight、petBounds；比例存入shell-state，尺寸调整保留模型底部中心并限制在屏幕可用区域内。气泡预留128px独立区域，不占模型画布。服务saveSettings可接收 `{apiBaseUrl,model,apiKey,rememberKey,workMinutes,restMinutes,noteProjectPath,noteDataDir}`。

公开state：`{settings:{apiBaseUrl,model,hasApiKey,workMinutes,restMinutes,noteProjectPath,noteDataDir}, notes:{connected,error,revision,items:[]}, focus:{phase,paused,remainingMs,totalMs,taskId,text,completedToday,focusMinutesToday}, chat:{messages:[{role,content}],busy,error}}`。不返回原始Key。onChat事件 `{type:'start'|'delta'|'tool'|'done'|'error',text?,name?,result?,message?}`。`sendMessage`可等待完成，期间持续发事件。

## 便签接口

确认关联目录为 `D:/project/便签`，remote `git@github.com:sanyingzhuoxiaoji/desktop_note.git`。数据目录允许 `DESKTOP_NOTE_DATA_DIR` 覆盖；`--background` 启动隐藏窗口。

便签主进程唯一权威TaskStore与落盘者，渲染端不再保存全量任务快照。`task-store.cjs` 导出 `TaskStore`：`new TaskStore({filePath})`，`snapshot()` 返回 `{revision,data}`，`create({text,remindAt?,note?,images?})` / `update(id,patch)` 返回 `{item,snapshot}`，任务变更保持其他字段。`data`沿用现有{version,title,themeColor,bgImage,collapsed,items}；保留历史所有item字段。可新增用于便签UI的其他方法，但不保留旧全量保存写接口。

`pet-bridge.json` 写在便签dataDir：`{version:1,port,token,pid}`。仅127.0.0.1，Authorization: Bearer token。接口：
- GET `/v1/state` → `{revision,data}`。
- POST `/v1/tasks` → `{item,snapshot}`。
- PATCH `/v1/tasks/:id` → `{item,snapshot}`，允许text/note/images/status/remindAt；remindAt变更重置reminded并重新调度。
- GET `/v1/events` SSE，连接先发 `event: snapshot`，变更发 `event: state`，两者data都是 `{revision,data}`；提醒 `event: reminder` data `{item}`。
- 错误JSON `{error}`，状态码401/400/404/409/500与真实失败匹配。
- `GET /v1/state` 会含图片，桌宠渲染可展示文本；给LLM的工具结果必须剔除图片dataURL。

## GLM聊天模块

`src/services/chat.cjs` 导出 `ChatService`：`new ChatService({filePath,fetchImpl?,now?})`；`messages()`返回仅可展示的user/assistant记录；`clear()`；`send({text,config:{apiBaseUrl,model,apiKey,thinking?,reasoningEffort?},tools,executeTool,onEvent,signal?})`返回最终assistant内容。tools为OpenAI function schema，executeTool(name,args)为异步真实业务执行。SSE流收集content与按index分片的tool_calls，工具回执进入下一轮messages；工具失败返回真实错误，不能伪造成功。GLM 5.3系列自动启用thinking及reasoning_effort:low，工具回合保留原始reasoning_content但不展示；其他模型沿用关闭thinking，thinking:false可省略该字段。会话持久化不保存Key。支持取消，不自动重试任务写入。不得读取环境里的其他凭据。官方文档：https://docs.bigmodel.cn/cn/guide/capabilities/function-calling.md 、https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode.md 。

## 番茄钟模块

`src/services/pomodoro.cjs` 导出 `Pomodoro`：`new Pomodoro({filePath,now?,onChange?,onComplete?,autoTick?})`，autoTick默认true；方法 `start({taskId?,text?,workMinutes?,restMinutes?})`, `pause()`, `resume()`, `stop()`, `startRest()`, `tick()`, `snapshot()`, `close()`。

snapshot：`{phase:'idle'|'work'|'workEnd'|'rest'|'restEnd',paused,remainingMs,totalMs,taskId,text,completedToday,focusMinutesToday}`。workMinutes默认25、restMinutes默认5；允许正数秒级小数用于真实短回合验证。运行中按endAt与now计算，暂停保存remainingMs；暂停时间不计专注；运行中重启按原endAt恢复，到期只完成一次；休眠按墙钟经过时间处理。workEnd显式startRest，restEnd显式start下一轮。持久化运行态和专注记录，完成不改待办状态。
