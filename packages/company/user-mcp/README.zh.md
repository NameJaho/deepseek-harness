---
description: "将已登录成员有权限的 MCP 服务器接入该成员的 Agent 作用域。"
kind: "package-reference"
---

# @deepseek-ai/dsh-company-user-mcp

[English](README.md) | 中文

## 概述

此 Host 服务使用已验证的登录 principal 查询用户 MCP 目录，为每个有权限的 MCP 换取短期平台令牌，并且只在该成员的 Agent 作用域注册发现到的工具。API key、HMAC 密钥、令牌响应和上游地址都只留在 Host。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

测试 Web overlay 通过 `packages/company/wecom-auth/cordis.patch.yml` 挂载本包。服务端环境设置 `DSH_USER_MCP_ENABLED=1`、`DSH_MCP_LIST_API_KEY` 和 `DSH_MCP_PLATFORM_SECRET`。其他 `DSH_MCP_*` 变量用于选择目录地址、换 token 地址、平台标识、环境和密钥变量名。密钥不会写入 YAML 或浏览器代码。

Remote 方法 `companyUserMcp.catalog()` 只返回当前登录用户的 MCP id、名称、描述、环境和取用方式；Remote 调用方需要 `companyUserMcp/catalog` 授权，企业微信 global 角色已包含该授权。调用方没有成员 `userId` 时，方法以 `company-user-mcp/unauthenticated` 拒绝；目录不可达或响应无效时报告 `company-user-mcp/catalog-failed`。

Agent 的成员取自最新待处理用户消息上的 principal；没有时，通过仅 Host 可见的 `companyUserMcpPrincipal` Session projection 读取 Session `user/message` 记录的最新 principal。之后没有 principal 的消息不会改变该成员。Agent 创建时、带 principal 的消息进入其 inbox 时以及每个 step 之前都会开始同步。每个 Agent 同一时间只运行一次同步：已加载目录在 `catalogTtlMs`（默认 60 秒）内复用，撤销的服务器被关闭，新授权的服务器并行连接，成员变化时替换全部连接。每个连接使用自己换得的令牌，令牌在到期前一分钟内才重新换取。

`requestTimeoutMs` 限制一次目录调用或换 token 请求，`connectionTimeoutMs` 限制 MCP 初始化，`toolCallTimeoutMs` 限制一次工具调用。缺少凭据、目录失败、换 token 被拒绝或服务器不可达时只记录警告，不会让本轮失败：Agent 保留当前工具，下次刷新重试被跳过的服务器。step 被取消时只停止等待，共享的同步继续运行。释放 Agent 或本服务时关闭 MCP 客户端并注销工具。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

目录客户端以 `thirdUid`、`accessType: "all"`、第 1 页和 `maxServers` 页大小调用 `queryUserAvailableMcp`，再校验结果中的 `structuredContent`。换 token 请求对 `platformId`、秒级时间戳、随机 nonce 和实际发送 JSON 字节的 SHA-256 摘要做 HMAC-SHA256 签名，并以 `X-Platform-Signature: v1=<hex>` 发送。MCP 地址是返回的 `resource` 加上 `/mcp`，已以 `/mcp` 结尾时保持不变。工具名使用清洗后的服务器名加 8 位 SHA-256 后缀，避免清洗后同名的两个服务器冲突。源码：[`src/index.ts`](src/index.ts)，配置：[`src/config.ts`](src/config.ts)。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 有权限的 MCP 工具

#### 模型看到什么

模型看到 `mcp__<server>__<tool>` 命名下的普通 MCP 工具 schema，不会看到成员 ID、Bearer token、HMAC 密钥、换 token 请求头或上游 endpoint。

#### Token 影响

只有发现到的工具 schema 和工具结果进入模型请求；目录和换 token 元数据只在 Host 处理。

#### KV Cache 影响

成员有权限的 MCP 目录变化会让下一次请求系列重新采用工具集合；凭据不会进入缓存 prompt。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- step 的工具集合在 `agent/pre-step` 之前确定，因此在该 step 中首次连接的工具从下一个 step 起可用；新 Session 第一轮的第一次模型请求可能没有这些工具。
- 目录请求只取一页 `maxServers` 条记录，超出该页的服务器会被忽略。
- step 期间连接断开会使该次工具调用失败；在服务器被撤销后重新授权或成员变化之前，桥接不会重连已列出的服务器。
- 授权由平台决定：已列出服务器的换 token 被拒绝，或服务器拒绝其令牌时，只会记录警告并跳过。
- 目录校验器只接受带 `success` 和 `data.records` 的 `structuredContent`；上游 wire 格式变化时需要同步更新。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

设计依据：[已认证用户 MCP 桥接](../../../.agents/notes/implemented/feature/2026-11-02-authenticated-user-mcp-bridge.zh.md)。

</details>
