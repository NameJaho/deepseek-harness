---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-mcp-market-member-authorization

English | [中文](2026-10-31-mcp-market-member-authorization.zh.md)

## Summary

Adds durable Cloud Agent ownership and release bindings. The persisted RPC source Principal union also includes the verified WeCom and gateway variants supplied by company authentication.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The principal property was already optional; this transition adds WeCom and gateway union alternatives while retaining owner and share-viewer alternatives and the existing user source discriminator. New readers preserve older RPC attribution, including sources without principal, and do not infer an MCP member from absent attribution. Older readers preserve the added JSON metadata on ordinary user sources; that metadata alone grants no MCP authority. New readers retain existing conversation-domain ownership when a binding event is absent and refuse a retained Cloud Agent Session when neither durable membership nor a binding establishes ownership. Ordinary Sessions remain readable. The cloud-agent/binding event is required, not ignorable: an older reader that does not recognize it refuses the Session as unsupported instead of dropping its ownership information. These refusal signals permit the same Session format version.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/company packages/session/session-persistence/tests/storage-contract.spec.ts packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts: 16 files and 177 tests passed, including member identity, retained ownership, unknown required-event refusal and preservation of source JSON metadata. The company-mcp-member headless recorded-session replay and three corpus checks passed; the first HTTP tool call succeeds and the second fails after revocation.

<a id="dev-note"></a>
## Dev Note

None.
