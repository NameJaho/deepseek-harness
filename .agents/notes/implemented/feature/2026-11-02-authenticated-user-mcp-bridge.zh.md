# Agent Note: 已认证用户 MCP 桥接

Status: implemented

[English](2026-11-02-authenticated-user-mcp-bridge.md) | 中文

## 问题

部署需要向每个已登录成员展示其可用的 MCP 服务器，并让这些服务器在该成员的 Agent 中可用。现有 MCP 客户端只接受静态 endpoint 和 header，而平台要求按用户做 HMAC 换 token，并通过单独的目录 MCP 调用获取列表。

## 决策

`@deepseek-ai/dsh-company-user-mcp` 负责此集成。它从最新待处理用户消息读取已认证成员 ID；没有时，通过仅 Host 可见的 Session projection 读取 Agent Session 记录的最新 principal，因此恢复或 fork 的 Session 无需扫描事件日志也能保留成员。它使用仅 Host 持有的 API key 调用目录 MCP，按 `(user, mcp, environment)` 换取一个短期令牌，并通过现有 `dsh-mcp-client` 桥接在 Agent 作用域中注册发现到的工具。工具和连接状态随 Agent 释放。该 bundle 默认关闭，所有密钥都从进程环境变量读取。

目录服务通过普通 MCP `initialize`、`tools/list` 和 `tools/call` 操作使用。换 token 请求对实际通过 HTTP 发送的 JSON 字节按 `app_id + timestamp + nonce + sha256(body)` 签名，缓存的令牌在到期前一分钟刷新。浏览器和模型只收到目录摘要和工具 schema；凭据、resource 地址和换 token 请求头都留在 Host。

## 考虑过的替代方案

曾考虑使用现有的静态 `mcp-client` 配置，但它无法选择用户身份，也无法执行平台 HMAC 换 token。浏览器侧令牌流程被否决，因为它会暴露平台密钥并绕过 Host 侧的 principal 授权。把目录复制进 Agent loop 也被否决，因为 MCP 注册和清理已经归工具桥接和 Agent 作用域所有。

## 后果

成员只能看到为其本人 principal 返回的工具，Agent 释放后工具注册随之消失。Remote 目录方法以结构化 `RemoteError` 代码报告失败。在一轮对话内，目录、换 token 和连接失败按服务器隔离并记录日志，因为一个不可用的上游不应让成员的对话失败；Agent 保留当前工具，直到下次刷新。

由于 agent loop 在 `agent/pre-step` 之前确定 step 的工具集合，同步会在 Agent 创建、消息进入 inbox 以及每个 step 之前开始。在某个 step 中连接的工具仍然只从下一个 step 起可用；消除这一延迟需要 agent-loop 扩展点。每个 Agent 的目录 TTL 限制目录请求量，令牌在到期前一分钟内才重新换取。
