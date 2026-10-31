---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-gateway-principal

[English](2026-10-31-gateway-principal.md) | 中文

## 概述

登录分支合并后，为持久化的 user 消息来源加入可信 gateway-user principal 变体。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-gateway-principal
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-31-wecom-principal-cloud-agent-binding"
    after: "8d70e21ad7aff2d5c7c7dca6b42e489ab0bbfc173e6a7d632e2cca1695588096"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-31-wecom-principal-cloud-agent-binding"
    after: "2e6bd71a3e95d52d1fa166908ed59d177de9b07b43a65d684ae71651da34c495"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-31-wecom-principal-cloud-agent-binding"
    after: "cbf6d9317090d6e2a03c922fc719f47e274a271a75790b6a1ed617c7c3183677"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-31-wecom-principal-cloud-agent-binding"
    after: "6dfe33d173f30b1330f5a812038b0ea578f26d2a32b0043cfacd47d0ca01c7d8"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍可读取，因为消息来源仍然是 user，principal 字段仍然可选。新增 gateway-user 只是生产者自有 principal union 的追加变体；未提供 gateway policy 的消费者会保留该来源，不会把它当成 owner 或另一种消息类型。Gateway 身份只用于 Remote 访问和企业所有权，不会进入模型可见内容。现有 discriminator 不变，SESSION_FORMAT_VERSION 保持不变。

<a id="verification"></a>
## 验证

corepack pnpm exec vitest run packages/company/wecom-auth/tests/service.spec.ts packages/company/cloud-agent/tests/host.spec.ts packages/company/cloud-agent-runtime/tests/runtime.spec.ts：3 个文件、47 个测试通过；corepack pnpm run build:check：Host 和 Client 聚合检查通过。

<a id="dev-note"></a>
## 开发备注

无。
