---
description: "企业 MCP 提供方接口、HTTP 网关适配器和浏览器安全的目录 Remote。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-mcp-provider

[English](README.md) | 中文

## 概述

本包定义 `ctx.companyMcpProvider`，它是 Host 中列出、启用和执行企业 MCP 工具的唯一路径。HTTP 适配器读取外部网关目录，并把工具调用转发给网关。`ctx.companyMcp` 向浏览器提供目录，不包含网关 URL、请求头或上游错误正文。Cloud Agent 只使用提供方，不直接访问网关。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把 `cordis.patch.yml` 应用到 Web profile，并在服务端环境设置 `DSH_COMPANY_MCP_CATALOG_URL`、`DSH_COMPANY_MCP_INVOKE_URL`。网关需要 bearer token 时，把它保存在凭据引用 `DSH_COMPANY_MCP_TOKEN`（`tokenRef`）下；每次请求都通过 `ctx.credentials` 解析，凭据未设置时不发送 `Authorization` 请求头。URL 缺失或不是 HTTP(S) 时插件拒绝启动。patch 把 `@deepseek-ai/dsh-company-mcp-provider/http` 挂载为提供方，把包根入口挂载为 `companyMcp` Remote。

`GET catalogUrl` 返回 `{ "servers": [...] }`。每个服务器包含 `id`（字母、数字和 `_ . : -`，最多 200 个字符）、`name`、可选 `description`、`status`（`available`、`connecting`、`failed` 或 `maintenance`）、可选 ISO 格式 `updated_at` 和 `tools`。每个工具包含 `name`、可选 `description` 和对象类型的 JSON Schema `input_schema`。服务器 id 重复、模型可见名称重复或 schema 不受支持时，整个响应被拒绝。

`POST invokeUrl` 接收 `{ "server_id", "tool", "arguments" }`，其中 `tool` 是网关的原始工具名。成功时返回 `{ "status": "ok", "is_error"?: boolean, "content": [{ "type": "text", "text": "..." }] }`；拒绝时返回 `{ "status": "error", "error": { "code", "message" } }`。其他响应、超时、取消、非 2xx 状态或超出大小限制的正文都使调用失败。

| 值 | Host 插件 | 浏览器 | 模型 | 日志和 Session |
| --- | --- | --- | --- | --- |
| `catalogUrl`、`invokeUrl` | 是 | 否 | 否 | 否 |
| `tokenRef` 的值 | 是 | 否 | 否 | 否 |
| 上游错误正文 | 否 | 否 | 否 | 否 |
| 服务器 id、名称、描述、状态 | 是 | 是 | 已选工具的名称和描述 | 工具结果中的工具名 |
| 工具 schema 和指纹 | 是 | 是 | 仅已选工具 | Cloud Agent release 中的指纹 |

`configure({ id, enabled })` 只保存启用状态。刷新失败时保留上一次成功的目录并报告 `failure`；从未加载成功的提供方报告 `loaded: false`，不返回空目录。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

`CompanyMcpProvider` 是 Service Definition；`HttpCompanyMcpProvider` 是 Service Provider；`CompanyMcpRemote` 和 Cloud Agent 是使用方。模型可见名称为 `mcp__company_<hash>__<tool>`，超过 64 个字符时用哈希缩短。指纹是工具名、描述和参数的 SHA-256；Cloud Agent 发布时固定指纹，执行时再与当前目录比对，不一致时以 `company-mcp/tool-changed` 失败。

请求使用 `redirect: 'error'`、解析出的 bearer token、单次请求超时、调用方信号和插件生命周期信号。响应最多读取配置的字节数，并按严格 UTF-8 JSON 解码。报告的失败使用固定消息，例如 `HTTP 503` 或 `timed out or was cancelled`，不包含 URL 或正文。卸载时取消挂起请求、等待进行中的调用并关闭偏好存储。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 企业 MCP 工具

#### 模型看到的内容

提供方本身不注册工具。Cloud Agent 注册 release 选中的工具；每个工具以 `mcp__company_<hash>__<tool>` 出现，带有网关提供的描述和参数，文本结果原样返回。

#### Token 影响

每个已选工具会在工具列表中加入名称、描述和参数 schema。结果加入其文本。

#### KV Cache 影响

工具列表由 release 固定，因此在同一 Session 内保持稳定，除非 release 变化。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 网关结果只接受文本内容块。
- 目录按需刷新，不定期轮询。
- 启用状态在部署范围内生效，不区分成员。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
