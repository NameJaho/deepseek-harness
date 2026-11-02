# Agent Note: 成员上传路由授权

Status: implemented

[English](2026-11-02-member-upload-route-authorization.md) | 中文

## Problem

原始 `/api/session/uploadFileBinary` 路由在上传处理器运行前拒绝所有已认证的非 Owner Peer。虽然企业微信成员的 Session 权限策略已经授予 `fileUploads/upload`，成员仍无法上传文件；反向代理可能把提前关闭的连接显示为 HTTP 502。

## Decision

精确上传路由允许非 Owner Peer 通过 Connection 的认证栅栏，并在 file-upload 包内使用现有的 `fileUploads/upload` action 和 Session resource 授权目标 Session。授权在读取请求体前执行。Owner 继续通过；有权限的成员只能向被授权的目标 Session 上传；无权限成员收到 403，存储服务不会被调用。生成的 Remote 上传 API 保持不变。

## Alternatives considered

- **保持路由只允许 Owner，并依赖 Remote 兜底。** 放弃：Blob 和 stream 上传使用原始路由，浏览器无法在不破坏一次性流和流式传输的情况下透明地转换为编码 Remote 请求。
- **只在浏览器授权，或等 Agent 解析完成后再授权。** 放弃：直接 HTTP 调用可以绕过浏览器检查；延后授权会先消费或保存未授权字节。
- **新增一个只给成员使用的上传端点。** 放弃：这会拆分认证、流式传输、取消和响应行为，而现有访问策略已经提供了正确的 action 和 resource。

## Consequences

上传路由现在依赖 `remoteAccess`，并将已认证 Peer 传给处理器。未授权的流式请求会在读取请求体前被拒绝，保留存储和背压保证。现有 Owner 上传、编码 Remote 调用、Session 凭证处理和 wire 格式不变。Host 测试覆盖非 Owner 授权，现有企业微信和 Session 上传测试覆盖组合与生命周期行为。
