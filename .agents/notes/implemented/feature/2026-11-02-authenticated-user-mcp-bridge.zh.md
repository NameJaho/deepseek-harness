# Agent Note: 已认证用户 MCP 桥接

Status: implemented

[English](2026-11-02-authenticated-user-mcp-bridge.md) | 中文

## 问题

部署需要向每个已登录成员展示其可用的 MCP 服务器，并让这些服务器在该成员的 Agent 中可用。现有 MCP 客户端只接受静态 endpoint 和 header，而平台要求按用户做 HMAC 换 token，并通过单独的目录 MCP 调用获取列表。

## 决策

`@deepseek-ai/dsh-company-user-mcp` 负责此集成。它从最新待处理用户消息读取已认证成员 ID；没有时，通过仅 Host 可见的 Session projection 读取 Agent Session 记录的最新 principal，因此恢复或 fork 的 Session 无需扫描事件日志也能保留成员。它使用仅 Host 持有的 API key 调用目录 MCP，按 `(user, mcp, environment)` 换取一个短期令牌，并通过现有 `dsh-mcp-client` 桥接在 Agent 作用域中注册发现到的工具。工具和连接状态随 Agent 释放。该 bundle 默认关闭，所有密钥都从进程环境变量读取。

目录服务通过普通 MCP `initialize`、`tools/list` 和 `tools/call` 操作使用。换 token 请求对实际通过 HTTP 发送的 JSON 字节按 `app_id + timestamp + nonce + sha256(body)` 签名，缓存的令牌在到期前一分钟刷新。浏览器和模型只收到目录摘要和工具 schema；凭据、resource 地址和换 token 请求头都留在 Host。

## 考虑过的替代方案

曾考虑使用现有的静态 `mcp-client` 配置，但它无法选择用户身份，也无法执行平台 HMAC 换 token。浏览器侧令牌流程被否决，因为它会暴露平台密钥并绕过 Host 侧的 principal 授权。把目录复制进 Agent loop 也被否决，因为 MCP 注册和清理已经归工具桥接和 Agent 作用域所有。

## 后果

成员只能看到为其本人 principal 返回的工具，Agent 释放后工具注册随之消失。Remote 目录方法以结构化 `RemoteError` 代码报告失败。在一轮对话内，目录、换 token 和连接失败按服务器隔离并记录日志，因为一个不可用的上游不应让成员的对话失败；Agent 保留当前工具，直到下次刷新。

由于 agent loop 在 `agent/pre-step` 之前确定 step 的工具集合，同步会在 Agent 创建、消息进入 inbox 以及每个 step 之前开始。在某个 step 中连接的工具仍然只从下一个 step 起可用；消除这一延迟需要 agent-loop 扩展点。每个 Agent 的目录 TTL 限制目录请求量，令牌在到期前一分钟内才重新换取。

## 公司 MCP provider

启用后，同一个插件也实现 `ctx.companyMcpProvider`，因此公司 MCP 页面与云端 Agent 能力选择读取的是 Agent 桥接所用的同一份成员目录。此模式下禁用 Market HTTP 适配器，因为 provider 接口只接受一个实现。provider 以已验证的 WeCom 登录 `sub` 为键；门户登录没有 WeCom 成员 id，直接返回 `company-mcp/member-unresolved`，不做猜测映射。

provider 基于成员有权限的用户 MCP 执行已解析的工具，换 token 方式与桥接相同，每次调用使用一个短生命周期会话；失败时以 `company-mcp/call-failed` 拒绝。暂不共享 Agent 连接池：每次调用独立会话，使 provider 不在成员与发布之间保存状态。

云端 Agent 会话不接收桥接工具。其发布策略只启用明确的工具集合，桥接工具超出该集合时会被拒绝（`Only tools explicitly enabled for this Cloud Agent can be used`），同时还会让模型看到同一服务的第二套名字。桥接通过仅 Host 可见的投影，依据 `cloud-agent/binding` 事件识别云端 Agent 会话；该事件名以字符串类型声明，因为依赖云端 Agent 包会经由 wecom-auth 形成循环。MCP SDK 顶层的 `$schema` 标记在 schema 校验前被去掉，因为受支持的 JSON Schema 子集会拒绝它，且它不改变校验结果。

## 成员对默认智能体 MCP 的选择

桥接不再挂载全部有权限的服务。每位成员选择默认智能体可以使用的服务；选择保存在 Host 持有的 JSON 文件中，以平台 userId 为键。没有记录的成员不会获得用户 MCP 工具。选择“默认不选”而不是“默认全选”，是为了让新成员不会继承自己没有选择的工具，并使工具集合跟随明确选择，而不是跟随目录成员关系。

选择变化会重置受影响 Agent 的对齐时间，因此从下一个 step 生效。工具在 pre-step 钩子中被移除，所以观察到变化的那一个 step 仍会列出它们；这与上文已记录的新增延迟一致。Remote 拒绝不在调用者当前目录中的 id，因此存储的选择不会授予平台已撤销的服务：撤销仍由目录检查移除工具，存储的 id 不起作用。

默认智能体还可以在对话中通过 `user_mcp` 工具修改选择。工具参数在工具边界校验，每个名字都对照成员当前目录解析，因此模型只能从成员本就有权限的服务中选择；云端 Agent 会话中没有该工具。右侧栏的“个人能力”标签页通过同一个 Remote 修改该选择；其客户端是独立 bundle，只声明实际使用的壳层服务。公司知识库来源不属于本决策。默认智能体的知识库检索需要经过验证的来源绑定和指纹校验；而公司知识库包依赖 wecom-auth，wecom-auth 又依赖本包，必须先解开这个循环，知识库才能在这里绑定。
