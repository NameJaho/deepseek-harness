---
description: "通过官方扫码授权，将已保存的 Cloud Agent 发布到企微机器人并保留文字会话。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-wecom

[English](README.md) | 中文

## 概述

通过企微官方授权窗口扫码，将已保存的 Cloud Agent 发布为智能机器人。机器人使用授权时的不可变版本，为每个私聊或群聊保留持久会话。公司启动脚本随 Cloud Agent 创作层一起加载此层；标准 profile 需要同时加载两个补丁。Host 需要向外建立 WebSocket 连接，目前仅支持文字消息。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

### 加载公司 profile 层

此私有包由当前仓库提供。[公司启动器](../../../start-dsh-test.sh)加载此包的[补丁](cordis.patch.yml)，顺序位于 [Cloud Agent 层](../cloud-agent/README.zh.md#use-this-package)之后。内置 Web profile 也接受有序的 `--patch` 参数来加载两者，[Loader 测试](tests/profile.spec.ts)覆盖了这一路径。补丁插入 `company-wecom` 行，并把插件页收窄为企业 MCP、企业知识库和企微机器人；覆盖这些行可修改部署设置。

在 Cloud Agent 创作对话中，要求将已保存智能体发布到企微。工具会把已修改草稿发布为不可变版本，并返回授权卡片。点击**扫码发布到企微**、允许弹窗，然后在企微官方窗口扫码。浏览器将返回的凭据直接发送到 Host 凭据服务；不要把机器人 Secret 粘贴到聊天中。

在已保存智能体的对话中打开**智能体信息**，可授权当前准确的已发布版本、查看实际连接、重连或停用。侧栏申请会复用该版本尚未绑定的待授权请求，不会发布草稿修改。公司插件页只显示企业 MCP、企业知识库和企微机器人；机器人的操作仍可从智能体侧栏进入。授权完成先于网关认证；只有**已上线**确认收到网关认证响应。后续发布或从公共空间撤回不会改变已授权机器人的版本。每个私聊或群聊恢复各自的 Session，同一机器人串行处理消息。群成员共享该群的会话历史和所选能力。

### 配置与恢复

`company-wecom` 行接受以下设置。凭据属于凭据服务，不得放入这些配置。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `source` | `busyming-ai-harness` | 官方授权来源标识 |
| `wsUrl` | `wss://openws.work.weixin.qq.com` | 官方网关；私有部署可覆盖 |
| `authorizationTimeoutMs` | `600000` | 授权有效期，单位为毫秒 |
| `responseTimeoutMs` | `240000` | 处理期限和 SDK 请求超时，单位为毫秒 |
| `maxBindings` | `20` | 保留的机器人数量及最大并发连接数 |
| `maxQueuedMessages` | `20` | 每个机器人的待处理消息数，包含正在处理的消息 |
| `maxInputChars` | `16000` | 输入文字长度上限 |
| `maxReplyBytes` | `20000` | UTF-8 回复字节上限，包含截断提示 |
| `maxRequests` | `1000` | 保留的授权请求数；发起授权时清理过期请求 |
| `maxConversations` | `1000` | 保留的私聊和群聊路由数 |
| `maxReceipts` | `10000` | 保留的消息去重记录数 |

凭据缺失或网关故障会让机器人保持离线。通过授权恢复凭据、检查出站网络，然后重新连接。失败或中断的提交可能已经执行工具：重复操作前先检查对应 Harness Session。未确认的消息不会自动重放。去重记录或会话存储达到上限会停止接收新消息；检查日志后增加相应配置上限。停用会停止接收新消息、取消其拥有的活动工作，并等待工作结算后断开连接。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>实现细节——点击展开</summary>

[服务](src/index.ts)在经过验证的 `company_wecom` domain 中管理授权请求、凭据引用、不可变版本绑定和哈希会话路由。它在入队前预留持久去重记录、跨重启保留提交不确定状态，并通过现有 Session controller 恢复会话。[消息通道](src/channel.ts)拥有官方 Node SDK 连接、有界队列、取消与最终回复；卸载会先排空工作，再关闭存储。

[浏览器插件](src/client/index.ts)挂载生成的 Remote 方法、跟随脱敏快照，并将共享状态注入工具卡片、管理页和 shell 所有的 toast。[授权弹窗](src/client/authorization.ts)遵循官方浏览器 SDK 协议，同时校验来源及窗口身份，并在每种终态移除监听器。凭据不会进入浏览器可观察状态、工具结果或路由记录。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [公司包](../README.zh.md)——部署能力及其所有者。
- [Cloud Agent](../cloud-agent/README.zh.md)——已保存草稿、版本与保留的 Session。
- [Storage domain](../../storage/storage-domain/README.zh.md)——经过验证的非 Session 记录。

-----

<a id="model-experience"></a>
## 模型体验

### `/发布企微` 发布命令

#### 模型看到什么

命令只对当前成员在当前对话中拥有的已发布版本发起扫码请求。请求会出现在企微机器人页面和 Agent release 操作区；授权完成前不会保存机器人绑定。扫码授权不代表网关已上线，实时状态通过 Remote 页面显示。版本指令和机器人消息通过普通持久 Session 到达固定 release。

#### Token 影响

命令不进入模型提示词，也不会增加模型请求 token。命令结算记录和机器人消息、回复进入普通 Session 日志。

#### KV Cache 影响

命令名称和参数保持稳定；即使草稿被编辑或重新发布，机器人的保留版本仍固定其模型和指令。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- 真实账号扫码与配置的 `source` 是否被接受，需要在目标企微环境验证。自动化测试使用本地授权页和网关。
- 此包仅支持文字，不支持主动通知、文件发送、绑定删除或去重记录清理。机器人不能改绑到另一版本；需要为该版本创建新机器人。
- 管理按企微成员 owner scope 隔离。群聊共享该机器人的历史；MCP 工具在每次执行前重新检查当前成员权限和已固定的 schema fingerprint。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
