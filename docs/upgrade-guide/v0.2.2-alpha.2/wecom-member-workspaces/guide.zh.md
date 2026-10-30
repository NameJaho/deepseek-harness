---
kind: upgrade-guide
description: "企业微信成员现在使用相互隔离的默认 Workspace，需要准备可写的 Workspace 根目录并迁移成员数据。"
---

# 企业微信成员使用隔离的默认 Workspace

[English](guide.md) | 中文

## 变更

此前企微部署不会为每个成员提供可见的 Workspace，也无法通过 Remote 安全暴露成员会话。现在登录层会在 `DSH_WECOM_WORKSPACE_ROOT` 下为每个启用成员创建一个持久的 `default` Workspace，并把 Workspace 和会话访问限制在该成员范围内。成员不能使用其他 `workspaceId` 或原始 `cwd` 创建会话。

## 迁移

1. 确保服务运行用户对 `DSH_WECOM_WORKSPACE_ROOT` 配置的目录拥有读、写和进入权限。测试启动器默认使用 `$DSH_BASE/workspaces`；需要其他位置时设置绝对路径。
2. 保留同一根目录下已有的成员数据，或在重启前将每个成员目录移动到 `<workspaceRoot>/<identityId>`。identity id 是企微认证域保存的稳定 `i-...` 值。
3. 重启 Web profile 并重新登录。确认成员只看到一个标题为 `default` 的 Workspace，可以在其中创建会话，并且无法访问其他成员的 Workspace 或会话。
