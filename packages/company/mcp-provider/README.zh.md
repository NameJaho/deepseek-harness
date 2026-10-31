---
description: "按成员授权的 MCP 市场 Provider、HTTP 适配器和浏览器安全目录 Remote。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-mcp-provider

[English](README.md) | 中文

## 概述

Provider 通过服务端凭据访问 MCP 市场。企微 `sub` 由已验证的 Remote 调用者或发起 Session 解析，浏览器和模型不能传入用户身份。市场只返回该成员可见、已上架且有使用权限的 MCP。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

`baseUrl`、`corpId`、`tokenRef`、请求限制和超时属于部署配置。成员启用偏好使用已验证的所有者范围隔离保存。Provider 需要 `POST /api/internal/mcp/authorized/page`、`detail` 和 `invoke`，每个响应都必须满足 `success: true` 与 `code: "200"`，也不读取公开接口中的连接配置或上游凭据。

每次工具调用都会重新检查成员授权、上架状态和 schema fingerprint，然后把 `path`、原始工具名、参数及 fingerprint 转发给市场。目录请求失败会清空当前成员目录，旧 MCP 不会继续执行。

<a id="model-experience"></a>
## 模型体验

### 有权限的 MCP 工具

#### 模型看到什么

模型只能看到当前成员有权限的 MCP 工具名、说明、输入 schema 和文本结果，不会看到市场地址、服务凭据、企微身份字段或 integrationConfig。

#### Token 影响

当前成员目录中的工具 schema 和说明会占用模型 token。目录和执行结果进入正常 Session 历史，并随市场授权变化。

#### KV Cache 影响

授权目录不变时 MCP schema 前缀保持稳定。权限、schema fingerprint 或上架状态变化会替换可见 schema，并可能让前缀缓存失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 市场内部接口和服务凭据由部署方负责；当前本地测试使用 fixture，真实联调需要已部署的市场服务。
- 市场后端需要提供带身份校验的内部接口；本仓库只包含 DSH 适配器和契约 fixture。

<a id="dev-note"></a>
### 开发备注

Provider 必须从 `companyWecomAuth` 获取身份，浏览器 Remote 不得增加 subject 参数。
