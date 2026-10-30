---
kind: upgrade-guide
description: "企业微信成员现在使用服务端管理的 default Workspace，并需要更新后的设置和插件页面权限。"
---

# 企业微信成员使用服务端管理的 default Workspace

[English](guide.md) | 中文

## 变更

企业微信成员不能再创建或浏览主机目录。每个成员在服务端管理的根目录下拥有一个私有的 `default` Workspace，浏览器不会显示其文件系统路径。成员 Remote 策略现在授予现有界面所需的设置、模型、Agent 预设、插件清单、插件管理和插件市场接口。登录信息还会显示成员姓名、用户 ID、企业 ID，并预留 `admin`/`user` 角色字段。

## 迁移

1. 拉取 `login` 分支并重新构建 Host 和 Client 产物。
2. 确保 `DSH_WECOM_WORKSPACE_ROOT` 对服务账号可写。不要给成员策略增加目录浏览或 Workspace 创建权限。
3. 重启测试服务并重新登录。确认侧栏显示成员自己的 `default` Workspace，设置和插件入口出现，并确认 `/auth/me` 返回 `role: "user"`。
