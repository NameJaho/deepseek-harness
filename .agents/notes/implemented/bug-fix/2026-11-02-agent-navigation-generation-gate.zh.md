# Agent Note: 在连接代际切换期间保持 Agent 导航注册

Status: implemented

English | [中文](2026-11-02-agent-navigation-generation-gate.md)

## Problem

Cloud Agent 会话分别拥有物理 Workspace 注册，但侧边栏必须把它们投影成当前成员可见的一个 Agent 行。Client 启动或连接替换期间，Agent 导航 provider 会在私有目录 UI 重建前暂时消失，侧边栏因此先渲染物理目录，目录加载后才把这些行合并。

## Decision

Cloud Agent client 在连接 UI 宿主的整个生命周期内注册一个导航 gate。连接代际的目录 provider 尚未就绪或正在替换时，gate 返回 `undefined`，让 `WorkspaceNavigationGroups` 保持 pending，而不是回退到物理 Workspace 行。每个连接代际仍然独立拥有自己的 controller 和目录 provider；替换或销毁 provider 只改变 gate 的 source，Cloud Agent 插件卸载时才注销 gate。

## Alternatives considered

**继续注销 provider，只依赖 Workspace browser phase。** browser phase 只描述物理 Workspace 流，无法观察已经注销的 capability provider，因此生命周期空窗仍会暴露物理行。

**重连时继续显示旧 Agent 目录。** 旧连接代际的目录可能属于另一个认证成员，因此在新目录加载期间必须隐藏旧分组，而不是显示过期分组。

## Consequences

侧边栏在连接代际切换的短暂时间内保持空白，当前成员目录稳定后一次性显示合并后的 Agent 分组。Cloud Agent 插件卸载后仍会恢复物理 Workspace 行，目录读取失败也继续使用现有的未分组物理投影。gate 只增加内存中的一个观察器，不改变 Workspace 或 Cloud Agent 的持久化、网络数据和授权。

## Verification

导航测试覆盖 source 切换到 `undefined`、切换到新 provider 以及观察器清理。ui-workspace 和 Cloud Agent 相关测试共 548 项通过，仓库 typecheck 通过，仓库 lint gate 通过（仅保留已有的无关 warning）。
