---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-31-wecom-principal-cloud-agent-binding

[English](2026-10-31-wecom-principal-cloud-agent-binding.md) | 中文

## 概述

在 user-rpc 消息来源中加入企微成员 principal，并新增 Cloud Agent 的 `cloud-agent/binding` Session 事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

wecom-user principal 只写入已登录企微成员的 Peer 提交的提示；owner 提示仍然不带 principal，因此其来源和所有已有 Session 日志都不变。该值包含成员身份 id、corp id、user id、显示名称和角色，不包含 cookie、OAuth code 或应用 access token。未装载企微登录的构建仍把该消息视为普通用户消息，因为来源 kind 仍是 'user'，它不驱动的 principal kind 交给对应的驱动方处理。`cloud-agent/binding` 是新的事件类型，记录固定的 Cloud Agent release、Session 的 owner 范围和会话角色；未装载 Cloud Agent 的构建从不写入该事件，Cloud Agent 通过自己的投影读取最新 binding，因此没有该事件的已有日志仍是普通 Session。两个值都不进入任何模型请求。SESSION_FORMAT_VERSION 不变。

<a id="verification"></a>
## 验证

node node_modules/vitest/vitest.mjs run packages/company/wecom-auth packages/company/cloud-agent packages/company/cloud-agent-runtime：成员提示携带 wecom-user principal，成员只能看到自己的 Session，Cloud Agent 使用会话追加并投影 binding，fork 会继承它；12 个文件、109 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
