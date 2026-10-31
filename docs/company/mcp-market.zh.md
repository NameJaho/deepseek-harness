---
description: "DSH 按成员权限发现与调用 MCP 所需的市场内部 API。"
---

# MCP 市场接入

[English](mcp-market.md) | 中文

## 概述

DSH 按当前已认证企微成员查询和调用 MCP 工具。本参考页定义市场后端需要提供的内部 API。后端实现与生产联调属于部署前提；本仓库提供 DSH 适配器及确定性 fixture。

## 目录

- [身份与服务认证](#identity-and-service-authentication)
- [内部接口](#internal-routes)
- [调用校验](#invocation-checks)
- [部署与验证](#deployment-and-verification)
- [开发备注](#dev-note)

<a id="identity-and-service-authentication"></a>
## 身份与服务认证

Host 通过 `companyWecomAuth.marketSubject()` 从已启用的官方企微 Principal 或发起调用的 Session 持久化所有者解析 `corpId` 与 `sub`。`sub` 是官方企业成员 UserId，不使用显示名称。可信网关的 `userId` 有独立所有者范围，在建立到官方成员的已验证映射前会被拒绝。浏览器 Remote 不接受身份参数。

所有市场请求使用 `Authorization: Bearer <服务凭据>` 和 JSON。后端必须验证服务身份、限制其企业范围，并解析成员当前的可见与使用授权。持有服务凭据本身不代表成员有权使用全部 MCP。公开目录或仅创建者可见的连接配置不能证明使用授权。

<a id="internal-routes"></a>
## 内部接口

适配器在配置的 `baseUrl` 下发送 `POST` 请求。响应必须为 HTTP 成功状态，并同时满足 `success: true` 和字符串 `code: "200"`，其他情况均失败。成功 `data` 字段如下：

| 路由 | 请求字段 | 成功响应 `data` |
|---|---|---|
| `/api/internal/mcp/authorized/page` | `corpId`、`sub`、`pageNum`、`pageSize` | `records`、`total`、`pageNum`、`pageSize` |
| `/api/internal/mcp/authorized/detail` | `corpId`、`sub`、`id` | 服务字段和 `tools[]` |
| `/api/internal/mcp/authorized/invoke` | `corpId`、`sub`、`id`、`path`、`tool`、`arguments`、`schemaFingerprint` | `isError`、`content[{type:"text",text}]` |

服务记录包含字符串 `id`、`path`、`name`、`description`，字面值 `authorized: true`、`published: true`，以及 `available`、`connecting`、`failed`、`maintenance` 中的 `status`。详情工具包含字符串 `name`、`description` 和根 `type` 为 `object` 的对象 `inputSchema`。响应不得暴露 MCP 连接地址、上游凭据或 `integrationConfig`。

分页从 1 开始，每页数量由配置指定且不超过 100，所有页的 `total` 必须一致，服务 id 不得重复。详情必须返回请求的 id 以及与分页记录一致的 path。DSH 验证完整目录后才返回服务；不完整、重复、超限或不支持的 schema 均被拒绝。字节、数量与超时限制由 Provider [Config](../../packages/company/mcp-provider/src/http.ts)负责。

成员、可见范围、上架或使用授权校验失败时，后端返回 `FORBIDDEN` 或 `NOT_FOUND`；执行 fingerprint 过期时返回 `TOOL_CHANGED`。HTTP 403 也会拒绝访问。其他失败不返回目录。无法信任或被中断的执行响应会产生结果未知错误，用户重试前必须检查实际操作。`isError: true` 记录工具失败。

<a id="invocation-checks"></a>
## 调用校验

市场必须对每次详情和执行请求重新校验成员、所选 MCP、上架状态与当前 schema。执行前必须授权请求的 id、解析其当前 path 和原始工具名，并比对所传 fingerprint。这些校验必须与分发共享一致的授权/schema 视图，避免通过较早的详情响应绕过并发授权或工具变更。

DSH 对模型可见的 `{name, description, parameters}` 生成 SHA-256 fingerprint，输入为对象键按字典序排序、数组保持顺序且无额外空白的规范 JSON。`parameters` 是详情工具的 `inputSchema`。公开工具名由稳定服务 id 和原始工具名生成；命名与 fingerprint 的权威实现为 [companyMcpToolName 和 companyMcpFingerprint](../../packages/company/mcp-provider/src/provider.ts)。后端校验 `schemaFingerprint` 时必须使用相同表示。

DSH 读取既有 MCP 权限，成员可为 Cloud Agent 选择有权限的工具。DSH 不提交申请，也不授予、撤销或启用权限。目录请求读取当前授权，不使用共享用户缓存，失败返回空目录。Cloud Agent 保存和发布会固定工具 fingerprint，启动、模型步骤与执行均重新校验实际运行者权限。成员使用其他作者发布的公开 Agent 时使用自己的 MCP 授权，发布不会转移作者权限。

<a id="deployment-and-verification"></a>
## 部署与验证

可选的[市场 patch](../../packages/company/mcp-provider/cordis.patch.yml)依赖企微认证和凭据提供方。部署提供 `DSH_MCP_MARKET_URL`、`DSH_WECOM_CORP_ID` 和 `DSH_MCP_MARKET_TOKEN` 服务凭据引用。[Cloud Agent patch](../../packages/company/cloud-agent/cordis.patch.yml)消费该 Provider。这两个 patch 均不负责部署市场后端。

仓库测试覆盖双成员隔离、执行身份、撤权、未上架 MCP、schema 变更、失败响应及执行结果未知。真实 Loader fixture 组合 HTTP Provider 和浏览器 Remote。`company-mcp-member` 无密钥录制 Session 启动正式 headless profile，记录 HTTP 成功及随后撤权。真实市场联调需要后端接口和部署凭据；仓库 fixture 未完成真实市场联调。

<a id="dev-note"></a>
## 开发备注

无。
