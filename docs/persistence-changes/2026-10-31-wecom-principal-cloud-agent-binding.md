---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-31-wecom-principal-cloud-agent-binding

English | [中文](2026-10-31-wecom-principal-cloud-agent-binding.zh.md)

## Summary

Adds the WeCom member principal to user-rpc message sources and adds the Cloud Agent `cloud-agent/binding` Session event.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-31-wecom-principal-cloud-agent-binding
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "ab8ad5e488d57f6d3788e2e1dbdaffc6ae68c81cc5565e378567b9a991c7da18"
    decision: same-version
  - root: "event:cloud-agent/binding"
    previous: null
    after: "ec6a2b720fae6f7e20bee9ec2923434016deb6eccfcd2d800718735b9ed18e4c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "d386800b4bd010e49c1286be56a2531859fcee8a92beaf90266c13f228a23c92"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "8fd9828b9aea7005a3c6d619c2b4018586c5baa25e871283b14755dea43b788c"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "01808299d4a5460f8a15ed1cac68099145531f42b3db3ff7a387331f787d3c57"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

The wecom-user principal variant is written only for prompts that a signed-in WeCom member's Peer submits; owner prompts still omit principal, so their sources and every existing Session log are unchanged. The value carries the member identity id, corp id, user id, display name and role; it carries no cookie, OAuth code or app access token. A build without WeCom login keeps the message an ordinary user message because the source kind stays 'user', and a principal kind it does not drive is left to whoever drives it. `cloud-agent/binding` is a new event type that records the pinned Cloud Agent release, the Session's owner scope and its conversation role; a build without Cloud Agent never writes it, and Cloud Agent reads the latest binding through its own projection, so existing logs without it remain ordinary Sessions. Neither value is part of any model request. SESSION_FORMAT_VERSION does not change.

<a id="verification"></a>
## Verification

node node_modules/vitest/vitest.mjs run packages/company/wecom-auth packages/company/cloud-agent packages/company/cloud-agent-runtime: member prompts carry the wecom-user principal, members see only their own Sessions, Cloud Agent use Sessions append and project the binding, and forks inherit it; 12 files and 109 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
