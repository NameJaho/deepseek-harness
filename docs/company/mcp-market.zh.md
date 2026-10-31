---
description: "使用市场已有接口展示当前登录成员有权限的 MCP 目录。"
---

# MCP 市场成员目录

[English](mcp-market.md) | 中文

## 概述

企业 MCP 页面展示当前登录用户已上架、可见且具有使用权限的 MCP。适配器使用市场已有接口，实际工具调用和上游网关认证暂未接入。

## 目录

- [身份解析](#identity-resolution)
- [已有只读接口](#existing-read-apis)
- [目录与工具详情](#directory-and-tool-details)
- [部署与验证](#deployment-and-verification)
- [开发备注](#dev-note)

<a id="identity-resolution"></a>
## 身份解析

Host 通过 `companyWecomAuth.marketSubject()` 从已验证的 Remote 调用者或 Session 持久化所有者取得 `CompanyMarketSubject`。官方企微身份提供 `corpId/sub`，可信门户身份提供门户用户 id。浏览器不能指定其他成员身份。

适配器直接使用已验证的官方企微 `sub`，不要求成员具备市场管理员权限。可信门户身份才通过 `admin/user/list` 按数字 `userId` 精确匹配，再使用映射出的企微 id。门户映射缺失或有歧义时返回结构化失败，不按姓名猜测，也不把企微 id 当作门户 id。

市场列表、详情和工具查询携带 URL 编码的 `X-User-Info`，包含解析后的门户 `userId/userName`。这是可信后端身份断言，不是登录凭据。权限检查使用解析后的企微 `sub`。原始 HR 记录、身份头和连接配置均保留在 Host。

<a id="existing-read-apis"></a>
## 已有只读接口

下列均为已有 `POST` 接口，路径相对于配置的市场根地址，该根地址包含 `/mcp-market` context-path。Controller 成功响应必须同时满足 HTTP 成功、`success: true`、字符串 `code: "200"` 和预期的 `data` 字段。

| 路由 | 请求字段 | 用途 |
|---|---|---|
| `/api/mcp/admin/user/list` | 可信门户身份传 `activeOnly: true`、`pageNum/pageSize` | 精确解析门户到企微的身份映射；官方企微身份不调用此管理接口 |
| `/api/mcp/list` | `accessFilter: "all"`、`pageNum/pageSize` | 查询映射门户用户可见的已上架候选服务 |
| `/api/internal/mcp/permission/check` | `sub`、`path` | 校验实际成员当前的使用权限 |
| `/api/mcp/query/by/id` | 数字 `id` | 显式发现工具前复核所选服务 |
| `/api/mcp/tool/list` | 数字 `mcpServiceId` | 读取工具名、说明和字符串编码的 `inputSchema` |

列表接口负责上架状态和门户可见范围。权限接口不检查上架，因此不能代替列表。每个返回服务还必须满足 `allowed: true`，并核对身份、path 和资源 id。适配器排除改造中的服务，不发送管理员权限声明，也不调用申请、授予或撤销接口。

<a id="directory-and-tool-details"></a>
## 目录与工具详情

目录查询直接返回服务名、说明和列表中的工具数量，不拉取工具 schema 或连接端点。显式发现工具时，先重新检查当前授权目录，再读取详情和工具。工具 schema 必须能从 JSON 字符串解码为受支持的对象 schema。工具 schema 非法只让详情发现失败，不影响目录读取。

身份解析、分页和权限检查共享整次操作的超时及字节预算。分页总数必须一致，服务 id 不得重复。不安全的数字 id、不完整分页、超限响应、权限响应不匹配或失败信封均返回空目录及失败信息，不使用共享成员目录缓存。

Cloud Agent 草稿能力元数据仍可使用已发现的工具。执行定义在发出任何调用请求前返回 `company-mcp/call-unavailable`。适配器不会调用虚构的执行端点，也不会将目录访问权当成 MCP 传输凭据。

<a id="deployment-and-verification"></a>
## 部署与验证

可选的[市场 patch](../../packages/company/mcp-provider/cordis.patch.yml)依赖公司身份服务。`DSH_MCP_MARKET_URL` 指向已有后端根地址；官方登录复用已有的 `DSH_WECOM_CORP_ID`。适配器不要求独立市场服务 Token。请求限制见 [Config](../../packages/company/mcp-provider/src/http.ts)。

当前适配器面向可信内部后端，管理端 HR 只读查询和内部权限检查须由部署网络限制访问。公网门户网关可能还要求自己的登录态和操作资源上下文；适配器不会伪造这些凭据。真实网关认证和 MCP 执行需要另行接入。

测试覆盖身份精确映射、双用户隔离、开放服务、撤权、分页、读取上限、失败响应及工具发现失败。真实 Loader 组合 Provider 和成员 Remote。`company-mcp-member` 无密钥 headless 快照记录有权限的目录及撤权后的空目录。尚未验证生产市场连通性。

<a id="dev-note"></a>
## 开发备注

无。
