---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-gateway-principal

English | [中文](2026-10-31-gateway-principal.zh.md)

## Summary

Adds the trusted gateway-user principal variant to persisted user message sources after the login branch merge.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing records remain readable because the message source remains kind user and the principal field remains optional. New gateway-user values are additive to the producer-owned principal union; consumers that do not provide gateway policy retain the source without treating it as an owner or as a different message kind. Gateway identity is used only for Remote access and company ownership, and never enters model-visible content. No existing discriminator changes and SESSION_FORMAT_VERSION remains unchanged.

<a id="verification"></a>
## Verification

corepack pnpm exec vitest run packages/company/wecom-auth/tests/service.spec.ts packages/company/cloud-agent/tests/host.spec.ts packages/company/cloud-agent-runtime/tests/runtime.spec.ts: 3 files and 47 tests passed; corepack pnpm run build:check: host and client aggregate checks passed.

<a id="dev-note"></a>
## Dev Note

None.
