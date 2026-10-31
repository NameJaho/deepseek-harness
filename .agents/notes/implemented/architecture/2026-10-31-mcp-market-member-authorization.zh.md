# Agent Note: MCP 市场成员授权

[English](2026-10-31-mcp-market-member-authorization.md) | 中文

Status: implemented

## Problem

MCP 市场目录和执行接口必须对应已认证企微成员。浏览器传入的身份、共享目录或发布者凭据都可能让一个成员看到或执行另一个成员的 MCP。

## Decision

Host 从已验证的企微 Principal 或发起 Session 的持久所有者解析 `WecomMarketSubject`。浏览器 Remote 不接收 subject 字段。MCP Provider 使用部署服务凭据，将该身份发送给市场的内部分页、详情和执行接口。可见范围、上架状态和使用授权由市场负责。

成员偏好使用所有者范围和服务器 id 作为键。授权或刷新失败会清空目录。Cloud Agent 发布时保存 schema fingerprint；启动 release 和每次执行都会重新校验当前授权、上架状态及 fingerprint，因此公开 release 按实际运行成员的权限执行。

## Alternatives considered

共享网关目录实现更简单，但后端请求没有已验证身份时无法区分成员。读取公开 MCP endpoint 配置会暴露创建者专属数据，也不能证明使用授权。从 Remote 参数传入 `sub` 被拒绝，因为调用者可以选择其他身份。

## Consequences

DSH 保持服务凭据和市场路由私有，模型只接收有权限的 MCP 元数据和结果。市场后端需要部署三个内部接口并接受 DSH 服务凭据。本地 fixture 验证 DSH 契约，生产联调仍属于部署工作。
