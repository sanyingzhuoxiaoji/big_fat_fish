# 大肥鱼桌宠

<!-- impeccable:product-schema 1 -->

## Platform

web

Windows Electron桌面应用，界面以HTML/CSS呈现，不是网站。

## Stack

用户已确认方案并授权普通实现细节自行决定：Electron + 原生HTML/CSS/JS，Live2D使用PIXI/Cubism。desktop_note保持独立应用。

## Users

用户本人在Windows桌面聊天、查看待办、安排提醒并使用番茄钟专注。

## Product Purpose

以大肥鱼桌宠统一聊天、待办查看与专注入口；当前仅从本机安装的便签单向只读同步，任务编辑与提醒设置仍在便签中完成。

聊天人格由用户提供的小鲸鱼角色卡适配：短句、真诚、轻度傲娇，白饭/token梗作为调味；角色名与底层API模型身份分开，口吻不覆盖真实能力和权限。

## Operating Context

本地已提供大肥鱼Live2D资产及已安装的桌面便签；联动参考Angelina_Pet，渲染和动作参考鲸语 https://github.com/InariNGT-Ofiicial/jingyu-live2d-agent 。不运行便签源码或修改安装版。用户要求持续推进、逐阶段验证，每阶段立即提交推送GitHub。

## Capabilities and Constraints

API流式聊天与受限语义表情动作；便签→大肥鱼单向读取；任务绑定番茄钟；观察便签已提醒状态。动作依据当前模型资源和参数探测，API不能任意改参数或换装。本机便签唯一拥有任务写入和提醒调度。旧双向实现按用户要求注释保留、当前不启用。离线API错误不影响本地业务。不改系统/代理/OMP配置，不上传密钥/模型/运行数据，不伪造验证。UI细节由实现选择简单可维护方案。

## Brand Commitments

名称大肥鱼，使用原模型，不改模型结构。公开署名：原画及拆分神宫凉子，Live2D建模霓虹猫_NeonNeko，来源神宫凉子免费配布。禁止擅自重新分发模型。

## Product Principles

- 成功回执先于聊天中的完成承诺。
- 数据单一所有者，避免并发全量覆盖。
- 常用操作可直接发现，错误明确且可恢复。
- 模型是桌面陪伴主体，操作面板不遮住整个桌面。
