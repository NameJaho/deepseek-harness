# Agent Note: WeCom 成员专属默认 Workspace

[English](2026-10-30-wecom-member-workspace-isolation.md) | 中文

Status: implemented

## Problem

企微登录只建立了 `wecom-user` principal，却没有 Remote policy。成员页面因此拿不到会话、Workspace、设置和插件清单。把所有成员放进同一个默认 Workspace 也会让成员看到彼此的会话。

## Decision

`dsh-company-wecom-auth` 为每个启用的成员创建一个确定性的 Workspace 目录：`<workspaceRoot>/<identityId>`，显示标题固定为 `default`。登录建立本地会话前确保该 Workspace 存在；服务启动时也为已保存的成员恢复 Workspace。

Remote policy 只为该 Workspace 及其 `sessionIds` 建立资源绑定。列表和 Workspace stream 仍由各自 controller 过滤资源，因此成员只收到自己的 Workspace 和会话。`session/create` 只允许指定自己的 Workspace，并拒绝原始 `cwd`；Workspace 的删除和新目录注册不授予成员。`workspaceRoot` 由 `DSH_WECOM_WORKSPACE_ROOT` 配置，测试启动器默认使用 `$DSH_BASE/workspaces`。

浏览器 index 注入使用客户端读取的 `__DSH_WECOM_SESSION__`，客户端在现有 sidebar footer 显示成员名称，并在连接丢失后通过 `/auth/me` 重新登录。

## Alternatives considered

将所有企微成员授予全局 policy 可以快速恢复页面，但会暴露其他成员的会话和 Workspace，因此不满足成员隔离要求。把 owner 信息追加到 Session 持久化格式可以表达更细的归属，但会扩大 Session 格式迁移范围；本部署已有 Workspace 成员关系，使用确定性专属 Workspace 足以覆盖默认会话流。

## Consequences

成员必须通过自己的 Workspace 创建会话；历史上不属于该 Workspace 的会话继续对成员隐藏。Workspace 根目录需要由服务运行用户可创建和访问，Remote 快照在 Workspace/domain 变化后重新计算。删除或移动成员 Workspace 需要由 Owner 管理，避免成员删除自己的默认入口。
