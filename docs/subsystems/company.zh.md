---
description: "公司成员身份、有权限的 MCP 发现和按发布版本隔离的 Cloud Agent 服务。"
---

# 公司部署集成

[English](company.md) | 中文

## 概述

公司部署可以要求成员登录、选择有使用权限的 MCP 元数据，并发布可复用 Agent 版本。本参考页维护公司服务索引；[包分组](../../packages/company/README.zh.md)链接各配置的归属文档。

## 目录

- [身份与授权](#identity-and-authorization)
- [服务归属](#service-ownership)
- [Cordis API 参考](#cordis-api-reference)
- [开发备注](#dev-note)

<a id="identity-and-authorization"></a>
## 身份与授权

认证提供方从已验证的请求或 Session 持久化所有者解析成员归属。官方企微和可信网关身份保持独立归属范围。市场适配器精确解析 HR 与门户映射，读取已有列表和使用权限接口。当前请求、失败处理及暂缓的执行能力见[成员目录](../company/mcp-market.zh.md)。

<a id="service-ownership"></a>
## 服务归属

| 服务 | 归属文档 |
|---|---|
| `companyWecomAuth` | [成员登录与资源授权](../../packages/company/wecom-auth/README.zh.md) |
| `companyMcpProvider`、`companyMcp` | [成员目录与工具发现](../../packages/company/mcp-provider/README.zh.md) |
| `cloudAgents` | [草稿、发布版本与私有对话](../../packages/company/cloud-agent/README.zh.md) |

<a id="cordis-api-reference"></a>
## Cordis API 参考

生成的服务方法由各子系统维护，本索引链接对应参考页，不重复复制签名。

- [MCP 目录与工具发现](mcp.zh.md)
- [公司登录、身份与归属](credentials.zh.md)
- [Cloud Agent 服务](core.zh.md)

<a id="dev-note"></a>
## 开发备注

无。
