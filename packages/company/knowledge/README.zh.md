---
description: "通过外部 HTTP 检索服务提供已批准的企业知识来源，包含所有者测试页面和 Cloud Agent release 绑定。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-knowledge

[English](README.md) | 中文

## 概述

本包定义 `ctx.companyKnowledge`，它是 Host 中检索企业知识空间的唯一路径。Host 为每个逻辑来源配置直连 retrieve 地址和上游空间白名单。浏览器和模型只能看到来源 id、名称、描述和已校验的证据。Cloud Agent 草稿选择来源；每个 release 保存允许空间的指纹，运行时只通过该指纹检索。所有者可以在 **插件 → 企业知识库** 中测试来源。本包只接入已有的检索服务，不导入文档，也不管理空间。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

把 `cordis.patch.yml` 应用到 Web profile，并在服务端环境中把 `DSH_COMPANY_KNOWLEDGE_SOURCES` 设置为来源 JSON 数组。未设置时页面显示未配置状态。每个来源包含 `id`（小写字母、数字和 `-`，最多 64 个字符）、`name`、可选的 `description`、`searchUrl`（HTTP 或 HTTPS 的直连 retrieve 地址）和非空的 `spaceIds` 列表。直连接口不需要鉴权；请求不会发送 `Authorization` 请求头。非法 URL 和重复 id 会使激活失败，错误中不回显 URL。

```json
[{ "id": "operations", "name": "Operations manuals", "description": "Store equipment and procedures",
   "searchUrl": "https://workflow-engine.busyming.com/knowledge_search_api/retrieve", "spaceIds": ["207b3de8-ea9d-47ad-b6f8-044a2a1a7f37"] }]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sources` | `[]` | Host 持有的逻辑来源，含直连地址和空间白名单 |
| `topK` | `5` | 请求的段落数，范围 1 到 50 |
| `minimumScore` | `0.5` | 接受的最低重排相关度 |
| `timeoutMs` | `60000` | 单次检索的截止时间 |
| `maxQueryChars` | `16000` | 去除首尾空白后问题的最大字符数 |
| `maxResponseBytes` | `8388608` | 上游完整响应的字节上限 |

每次检索发送直连 `POST searchUrl`，请求体使用 `messages`、`space_ids`、`emotion`、`prev_method_id`、`verify`、`image`、`kb_ids`、`sources`、`top_k`、`filter_doc_type` 和 `exclude_needs_review` 等 retrieve 字段。`messages` 会携带完整的 user/assistant 对话，`space_ids` 始终由 Host 注入。响应必须包含按 `chunks`、`images`、`im` 和 `graph` 分组的 `results`，并保留 `signals`、`same_topic`、`locked_method_id`、`verified`、`sufficient`、`missing`、`conflicts`、`reply_strategy`、`references` 和 `activity` 等字段供 Cloud Agent 使用。出现白名单之外空间的文档结果、非法 JSON、正文不是 UTF-8 或超过字节上限时，整个响应都会被拒绝。低于 `minimumScore` 的段落和空白段落会从 UI evidence 列表移除，但原始分组结果仍保留在 `retrieve` 中。空结果表示没有找到可靠证据，不表示空间存在。传输、HTTP、超时和响应失败都保持为失败，错误码为 `company-knowledge/search-failed` 并带有 `reason`；它们不会变成空证据，也不包含 URL 或上游正文。

`catalog()` 和 `test()` 是管理页面使用的仅所有者 Remote 方法。页面显示带最近测试状态的来源卡片、带字符计数和取消操作的问题表单，以及包含文档标题、章节路径、相关度和完整段落的证据卡片。检索失败时保留上一次结果。同进程使用方调用 `sources()`、`binding(id)`、`validate(binding)` 和 `search(binding, query, signal, options)`。来源的空间列表变化后，`validate` 会以 `company-knowledge/binding-changed` 失败，直到发布新的 release；同一空间内的文档更新不需要重新发布。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

`CompanyKnowledgeService` 是 Service Definition，其 HTTP 检索是 Service Provider；管理页面和 Cloud Agent 是使用方。绑定指纹是排序并去重后的空间列表的 SHA-256。`search` 在发出请求前校验绑定和问题，然后合并调用方信号、插件生命周期信号和单次请求截止时间。请求使用 `redirect: 'error'`。响应在字节上限内完整读取，按严格 UTF-8 解码，并在接受任何证据前完成校验。插件卸载时中止并等待已接受的请求。

浏览器控制器同一时间只允许一次目录加载和一次检索。失败后保留上一次目录和结果，把失败分为加载、检索、超时和来源变化，并忽略已取消检索的结果。卸载时先中止并等待请求，再卸载 Remote 命名空间。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Cloud Agent](../cloud-agent/README.zh.md) — 草稿来源选择和 release 绑定。
- [Cloud Agent 运行时](../cloud-agent-runtime/README.zh.md) — `cloud_knowledge` 工具及其提示行。
- [企业包](../README.zh.md) — 企业集成。

-----

<a id="model-experience"></a>
## 模型体验

### 已批准的检索证据

#### 模型看到的内容

本插件不提供提示词或工具 schema。[Cloud Agent 运行时](../cloud-agent-runtime/README.zh.md#model-experience) 拥有 `cloud_knowledge` 工具，并返回本插件提供的段落、文档标题、章节路径和相关度。检索地址、凭据和空间 id 不会进入模型参数或结果。

#### Token 影响

调用工具会把选中的证据加入 Session。`topK` 和 `maxResponseBytes` 限制每次检索。

#### KV Cache 影响

检索不改变指令前缀或工具定义。每个结果都作为普通工具历史加入，只改变后续请求中未缓存的后缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 文档导入、索引构建和空间管理属于上游服务；页面只测试检索。
- 只实现了 HTTP 检索协议。Streamable HTTP MCP 知识服务需要单独的适配器，并复用相同的证据记录和错误码。
- 真实连通性和相关度阈值需要对已部署的服务进行检查；本地 fixture 覆盖协议和隔离规则。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
