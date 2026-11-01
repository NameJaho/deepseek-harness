---
kind: upgrade-guide
description: "企微机器人发布改为成员隔离，并使用 /发布企微 命令。"
---

# 企微机器人发布改为成员隔离

[English](guide.md) | 中文

## 变更

公司 profile 现在提供 `@deepseek-ai/dsh-company-wecom`。成员从自己拥有的 Cloud Agent 对话执行 `/发布企微`。命令会为精确的已发布版本创建扫码请求，不再通过模型可见的 `wecom_publish` 工具发布。机器人绑定、凭据和机器人 Session 按当前成员 scope 隔离。

## 迁移

1. 将 `company-wecom` patch 加在 `company-wecom-auth`、MCP Provider 和 Cloud Agent patch 之后，并在 patch 或部署环境中设置 WebSocket 地址和各项上限。
2. 使用 `/创建智能体` 和 `/发布智能体` 创建并发布 Cloud Agent，然后在版本发布后执行 `/发布企微`。原英文命令仍作为兼容别名接受。
3. 如果已有企微机器人记录没有 owner scope，请重新授权。不要根据当前浏览器会话把旧绑定分配给某个成员；应恢复为 `local-owner`，或执行经过审查的显式数据迁移。
4. 确认成员只能看到自己的待授权请求和绑定，机器人使用固定 release；成员失去权限或固定 schema 变化后，MCP 调用会失败。
