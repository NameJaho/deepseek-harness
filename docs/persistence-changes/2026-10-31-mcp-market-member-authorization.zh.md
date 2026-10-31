---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-mcp-market-member-authorization

[English](2026-10-31-mcp-market-member-authorization.md) | 中文

## 概述

新增可持久化的 Cloud Agent 所有权与发布版本绑定。持久化 RPC 来源的 Principal 联合类型还包含公司认证提供的已验证企微与网关成员变体。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-mcp-market-member-authorization
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "8d70e21ad7aff2d5c7c7dca6b42e489ab0bbfc173e6a7d632e2cca1695588096"
    decision: same-version
  - root: "event:cloud-agent/binding"
    previous: null
    after: "ec6a2b720fae6f7e20bee9ec2923434016deb6eccfcd2d800718735b9ed18e4c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "2e6bd71a3e95d52d1fa166908ed59d177de9b07b43a65d684ae71651da34c495"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "cbf6d9317090d6e2a03c922fc719f47e274a271a75790b6a1ed617c7c3183677"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "6dfe33d173f30b1330f5a812038b0ea578f26d2a32b0043cfacd47d0ca01c7d8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

principal 属性原本就是可选字段；本次新增企微与网关联合类型变体，保留 owner、share-viewer 变体和既有 user 来源判别字段。新读取方保留旧 RPC 归属信息，包括没有 principal 的来源，不会从缺失的归属信息推断 MCP 成员。旧读取方保留普通 user 来源新增的 JSON 元数据；这些元数据本身不授予 MCP 权限。缺少绑定事件时，新读取方保留会话存储域中的既有所有权；若持久化成员关系和绑定均无法确定所有者，则拒绝保留的 Cloud Agent Session。普通 Session 仍可读取。cloud-agent/binding 是必需事件，未标记 ignorable：不认识该事件的旧读取方将 Session 判为不支持并拒绝读取，不会丢弃所有权信息。这些拒绝信号允许维持相同 Session 格式版本。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/company packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts：16 个文件、177 个测试通过，覆盖成员身份、保留所有权、未知必需事件拒绝与来源 JSON 元数据保留。company-mcp-member headless 录制 Session 重放及三个语料检查通过；首次 HTTP 工具调用成功，第二次在撤权后失败。

<a id="dev-note"></a>
## 开发备注

无。
