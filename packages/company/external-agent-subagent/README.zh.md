---
description: "可选的仅 Host 外部 Agent 委派 Provider，通过 Subagent Provider 接口和私有 Dify 阻塞适配器执行任务。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-external-agent-subagent

[English](README.md) | 中文

## 概述

`ExternalAgentSubagentProvider` 为每个已配置的逻辑 Agent 注册一个 `ctx.subagents` 后端，只委派独立文本任务和显式配置的输入变量。外部应用自行管理模型、工具、知识访问和权限；不会继承父会话记录、shell、MCP、知识权限、文件、环境或凭据。这既不是 MCP 服务，也不是 Dify 项目或工作流执行。`DifyAdapter` 实现可替换的 `ExternalAgentAdapter` 接口；当前部署平台仅支持 `dify`。

## 目录

- [私有配置](#private-configuration)
- [调用、记录与续接](#calls-records-and-continuation)
- [失败处理](#failure-handling)
- [集成与验证](#integration-and-verification)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="private-configuration"></a>
## 私有配置

服务注入 `subagents`、`credentials` 和 `agents`。每个 Agent 的所有字段均为必填；`agents: []` 不注册任何 Provider。若同一个 Host 组合需要让模型使用委派能力，将 `registerTools: true` 设置为为每个逻辑 Agent 挂载一个模型工具；工具名由逻辑 id 派生。可选的 [bundle 补丁](cordis.patch.yml) 不会在全局启用；只有 `DSH_COMPANY_EXTERNAL_AGENTS` 提供非空 JSON 配置时才启用此模式。

```yaml
- name: '@deepseek-ai/dsh-company-external-agent-subagent'
  config:
    registerTools: true
    agents:
      - platform: dify
        id: research
        name: Research agent
        version: release-1
        environment: production
        providerName: external-research
        endpoint: https://dify.example.com/v1/chat-messages
        credentialRef: DIFY_RESEARCH_KEY
        inputs: { language: zh }
        timeoutMs: 60000
        maxInputBytes: 65536
        maxOutputBytes: 262144
        maxRetainedRuns: 1000
        allowContinuation: false
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: external-research
    toolName: subagent_external_research
    maxDepth: provider-managed
```

| 字段 | 含义 |
|---|---|
| `platform` | `dify`；不支持的平台会在加载时失败。 |
| `id`, `providerName` | 唯一逻辑 id 和 Provider 注册名；使用以小写字母开头的小写标识符。 |
| `name`, `version`, `environment` | 非空白部署描述，每个最多 128 个 UTF-16 码元；这些字段不会在远端选择应用。 |
| `endpoint` | 完整的 `/chat-messages` POST URL；使用 HTTPS，测试 fixture 可用回环 HTTP。拒绝内嵌凭据、查询串和片段。 |
| `credentialRef` | 凭据服务引用，而非 token；每次调用解析一次，不缓存。 |
| `inputs` | 与应用声明的输入变量一致的显式无损 JSON 对象；不猜测变量。 |
| `timeoutMs` | 整次调用的期限，包括凭据解析和响应体读取；取不超过 2147483647 ms 的正整数。 |
| `maxInputBytes` | 完整 UTF-8 JSON 请求体上限，包括协议字段和配置的输入。 |
| `maxOutputBytes` | 解压后的响应字节数及完整序列化成功结果的上限。失败诊断遵守接口单独规定的 4096 字节上限。 |
| `maxRetainedRuns` | 每个 Agent 保留描述记录的正整数容量；新请求会失败，而不是丢弃已有记录。 |
| `allowContinuation` | 允许仅由 Host 显式续接最近一次成功且归其所有的子任务。 |

数值上限均为正安全整数。无效部署配置会在注册 Provider 前失败。标准注册表拒绝 Provider 名称冲突。`agentOptions`、`agentPreset`、输出 schema 和本地深度上限均不受支持，接口与 Provider 执行器都会执行这一限制。

<a id="calls-records-and-continuation"></a>
## 调用、记录与续接

适配器使用 [Dify 文档定义的聊天 API](https://docs.dify.ai/api-reference/chat/send-chat-message)：阻塞式 `POST chat-messages`，仅发送 `inputs`、`query`、`response_mode: blocking`、由父 Agent 和逻辑 Agent 派生的不透明 `user`，以及可选的 `conversation_id`。只接受 HTTP 200、UTF-8 编码的 JSON，且响应必须包含完整的 `event: message`、`chat` 或 `advanced-chat` 模式，以及有效且非空的 `answer`、`conversation_id` 和 `message_id`。不会用事件 `id` 替代 `message_id`。忽略元数据；流式响应、部分答案、无效标识符和续接时改变的 conversation id 都会失败。禁止重定向和自动重试。

Host 服务提供 `catalog()`、`startActivation(agentId, spec, continuationOf?)` 和 `describeRun(agentId, parent, childId)`。`catalog()` 只包含逻辑描述和 configured/disposed 状态，不执行健康或凭据检查。`describeRun()` 保留父子关联、逻辑部署、时间戳、输入输出字节数及 SHA-256 引用、续接关系和结构化失败信息；不会暴露 endpoint、凭据引用、Bearer 值、远端标识符或答案内容。这些方法不注册浏览器 Remote 或执行端点；独立且经过授权的 UI 投影仅可使用安全的 `./types` 描述类型。

模型可见任务应使用托管的 `startActivation` 并指定 `delivery: parent`。现有 Subagent 管理器写入标准的外部子任务父目录记录，并通过已记录的 `subagent-settled` 通知交付结果。`delivery: caller` 只返回私有结果，不写父目录或通知；不得在未记录的情况下将其注入模型上下文。不存在本地子 Agent 或子会话记录。

续接会创建另一个标准外部 activation，并根据原始且仍存活的确切父 Agent、已配置逻辑 Agent 和最近一次成功子任务授权。拒绝重叠、过期或他人引用。确定未发送的失败会保留旧末端，以便显式重试；任何已发送请求的失败都会使该会话失效，即使 HTTP 拒绝已确定。续接不是标准的本地 `sendMessage` 操作。调用方信号只控制托管启动；发布后应使用返回 activation 的 `dispose()` 或标准的已授权中断。卸载 Provider 会停止接收请求、中止全部活动操作，并等待其传输和响应体清理；迟到的凭据解析不会发送 HTTP，Provider 仍会观察其拒绝结果。

<a id="failure-handling"></a>
## 失败处理

请求接收和配置失败以 `ExternalAgentError` 或标准 Cordis/Subagent 校验错误拒绝。已接收调用在失败时以无输出的 `SubagentResult` 完成：取消或卸载对应 `aborted`，其他失败对应 `error`。Provider 自有错误及保留记录包含稳定的失败 `code`、`not-sent`、`rejected` 或 `unknown` 效果，以及可选 HTTP 状态。诊断不会复制远端响应体、传输消息或凭据错误。取消不保证远端回滚；请求发送后的超时、连接丢失、无效响应和部分结果都属于未知结果。决定是否启动新的独立调用前，应先检查远端平台。

<a id="integration-and-verification"></a>
## 集成与验证

集成负责人需补充源代码及包解析、聚合 TypeScript 引用，更新 workspace/lockfile 依赖，在所选 bundle/profile 的解析清单中声明此可选 Provider，提供 Host overlay，并在产品包策略中分类。本包不改变任何默认发布 profile。浏览器执行、浏览器凭据访问及通过通用设置暴露私有部署配置均不属于其 API。

聚焦 HTTP fixture 和无需密钥的真实 Loader/headless-profile 组合测试，覆盖从持久化日志重建的成功及失败父结果交付。可在仓库根目录运行以下命令，避免触发包管理器安装：

```sh
node ./node_modules/vitest/vitest.mjs run packages/company/external-agent-subagent/tests
node ./node_modules/typescript/bin/tsc -p packages/company/external-agent-subagent/tsconfig.json --noEmit --incremental false --composite false
```

<a id="model-experience"></a>
## 模型体验

### 外部应用任务

#### 模型看到什么

外部应用接收传入的独立任务文本和配置输入变量；显式续接时还会使用其平台自有会话历史。不会注入父上下文；平台决定提示词和模型请求。

#### Token 影响

输入增长按编码请求字节数而非模型 token 限制。外部提示词、工具流量、token 统计和答案生成由平台管理；此 Provider 不发起本地子模型请求。

#### KV Cache 影响

新调用使用独立的平台会话。显式续接可能复用平台自有历史，但此 Provider 不保证缓存复用，也不管理远端 KV 状态。

### 通过 Subagent 管理器交付父结果

#### 模型看到什么

只有经过校验的答案或安全失败诊断通过现有日志通知交付父模型。工具回执和结果通知封装由标准 Subagent 工具及运行时管理。Provider 失败文本精确为 `External agent call failed ({code}; effect: {effect}). `，未知效果时追加 `The remote outcome is unknown; check the platform before starting a new call.`，否则追加 `Check the agent configuration or input before starting a new call.`

#### Token 影响

成功追加受完整结果字节上限约束的答案；失败则追加有界诊断，而非部分输出。标准通知另有封装 token。仅交付调用方的模式不会自动增加模型上下文。

#### KV Cache 影响

记录的结果通知只在父会话末尾追加，保留已有可复用前缀。答案或诊断变化只影响新增后缀；部署变化不会改写以前的父消息。Provider 缓存可用性和淘汰不属于本包保证范围。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

- **仅限当前进程的 Provider 记录** — 详细摘要、失败信息、部署身份和远端续接状态保存在进程内。只有标准父目录和结果通知持久化；卸载或重启不会恢复远端续接。容量耗尽需显式作出生命周期或配置决策，不会静默淘汰记录。
- **仅支持 Dify 阻塞应用** — 支持 Chatbot/Chatflow；需要流式响应的 Agent 应用会失败。不提供项目 API、工作流执行、流式输出、结构化结果、远端取消或自动重放。
- **私有 Host 部署** — 不提供浏览器注册或 UI 控件。集成必须防止 endpoint、inputs 和凭据引用配置进入通用浏览器配置导出，并独立约束外部应用权限。
- **构建与真实平台验证** — 根级解析、分类和聚合构建接线由集成负责人负责；fixture 仅覆盖源代码平面。无需密钥的 HTTP 测试不提供真实 Dify 凭据 smoke 或安装产物验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作背景 — 点击展开</summary>

无。

</details>
