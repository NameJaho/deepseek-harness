---
description: "通过 MCP 市场已有接口提供按成员隔离的目录和工具发现。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-mcp-provider

[English](README.md) | 中文

## 概述

登录成员可查看自己有使用权限的 MCP，并查看工具定义。Provider 解析市场身份，读取已上架且可见的候选服务，再通过已有使用权限检查过滤。不提供申请、授予、撤销或启用操作。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

[patch](cordis.patch.yml) 使用 `DSH_MCP_MARKET_URL` 和已有 `DSH_WECOM_CORP_ID`。`baseUrl`、`corpId`、超时和读取上限属于部署配置。Provider 依赖公司身份服务，不需要独立服务凭据。见[已有只读接口与部署要求](../../../docs/company/mcp-market.zh.md)。

目录使用市场列表提供的工具数量，不依赖工具发现。显式发现工具时先检查当前成员目录，再读取详情及工具定义。刷新失败会清空目录。Cloud Agent 草稿仍可使用工具 schema 和 fingerprint；执行会在发送请求前返回 `company-mcp/call-unavailable`。

<a id="model-experience"></a>
## 模型体验

### 成员目录与工具定义

#### 模型看到什么

Provider 不注册全局模型工具。创作功能可提供有权限的服务摘要、`mcp__company_<hash>__lookup` 等已发现工具的名称、说明和 schema。市场地址、HR 记录、身份头和 integrationConfig 保持私有。

#### Token 影响

浏览器目录查询不增加模型 token。创作功能的目录查询或显式工具发现可将有权限的元数据加入正常 Session 历史。

#### KV Cache 影响

浏览器刷新不改变模型提示词。消费方选择已发现工具的 schema 时，能力选择变更可能改变请求前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 身份解析要求唯一的在职 HR 映射、正数门户用户 id 和非空企微 id。
- 后端须能通过部署的可信内部网络访问；尚未接入或生产验证公网门户网关认证。
- 实际 MCP 传输鉴权和工具执行暂缓，读取目录或 schema 不代表已经建立可执行连接。

<a id="dev-note"></a>
### 开发备注

浏览器 Remote 自行解析当前登录身份，不接受浏览器传入的成员 id。
