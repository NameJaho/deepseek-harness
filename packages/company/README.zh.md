---
description: "企业部署集成：企微成员登录、企业 MCP、企业知识库、Cloud Agent 与外部 Agent 委派。"
kind: "package-group"
---

# company/：企业部署集成

[English](README.md) | 中文

## 概述

本组包含企业部署 Web profile 时使用的集成。企微登录识别成员并隔离其 Workspace，MCP 提供方是访问企业 MCP 工具的唯一路径，知识服务是访问已批准知识空间的唯一路径，Cloud Agent 基于这些工具和来源发布可复用的 Agent，外部 Agent 提供方把任务委派给 Dify 应用。各包 README 负责说明自己的配置和约定；它们都不属于默认 profile。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`wecom-auth`](wecom-auth/README.zh.md) | 企微自建应用登录与成员 principal | `companyWecomAuth` |
| [`mcp-provider`](mcp-provider/README.zh.md) | 企业 MCP 提供方接口、HTTP 网关适配器与目录 Remote | `companyMcpProvider`、`companyMcp` |
| [`knowledge`](knowledge/README.zh.md) | 基于 HTTP 检索的已批准知识来源和所有者测试页面 | `companyKnowledge` |
| [`cloud-agent`](cloud-agent/README.zh.md) | Cloud Agent 草稿、不可变 release、目录与使用会话组 | `cloudAgents` |
| [`cloud-agent-runtime`](cloud-agent-runtime/README.zh.md) | 每个 Cloud Agent Session 内按 release 固定的提示词与工具策略 | —（Agent 作用域插件） |
| [`external-agent-subagent`](external-agent-subagent/README.zh.md) | 带 Dify 阻塞适配器的外部 Agent subagent 提供方 | `externalAgentSubagents` |

<a id="related-documentation"></a>
## 相关文档

- [能力接口](../../docs/capability-seams.zh.md)——这些服务的所有者、实现与使用方。
- [Web 服务器](../../docs/subsystems/web-server.zh.md)——这些集成扩展的 Web profile。

<a id="dev-note"></a>
## 开发备注

无。
