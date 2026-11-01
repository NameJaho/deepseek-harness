---
description: "企业部署集成：企微成员登录、企业 MCP 和 Cloud Agent。"
kind: "package-group"
---

# company/ — 企业部署集成

[English](README.md) | 中文

## Summary

本组包含可选的企业 Web 部署集成。企微登录识别成员并隔离 Workspace，MCP Provider 只暴露成员有权限的市场工具，Cloud Agent 基于这些工具发布可复用 Agent。各包 README 负责自己的配置和接口约定。

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

| 包 | 作用 | ctx key |
|---|---|---|
| [`wecom-auth`](wecom-auth/README.zh.md) | 企微自建应用登录和成员身份 | `companyWecomAuth` |
| [`mcp-provider`](mcp-provider/README.zh.md) | 按成员授权的 MCP 市场 Provider 和目录 Remote | `companyMcpProvider`、`companyMcp` |
| [`cloud-agent`](cloud-agent/README.zh.md) | Cloud Agent 草稿、不可变发布版本、目录和使用会话 | `cloudAgents` |
| [`cloud-agent-runtime`](cloud-agent-runtime/README.zh.md) | 每个 Cloud Agent Session 中按发布版本固定的提示词和工具策略 | —（Agent 作用域插件） |
| [`wecom`](wecom/README.zh.md) | 按成员隔离的企微机器人授权、release 绑定和文字会话 | `companyWecom` |

<a id="related-documentation"></a>
## Related documentation

- [MCP 市场接入](../../docs/company/mcp-market.zh.md) — 内部接口、身份传递和失败处理。
- [能力接入点](../../docs/capability-seams.zh.md) — 这些服务的所有者、实现和消费者。
- [企业服务](../../docs/subsystems/company.zh.md) — 成员身份、目录和 Agent 服务索引。

<a id="dev-note"></a>
## Dev Note

无。
