---
description: "按所有者隔离的 Agent 草稿、不可变 MCP 与技能发布版本，以及私有使用对话。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-cloud-agent

[English](README.md) | 中文

## 概述

用于保存可复用对话需求并发布精确 MCP 与技能选择的可选 Host 和 Web bundle。执行只依赖 `ctx.companyMcpProvider` 一个提供方。包内不包含 MCP 目录实现、凭据编辑器、shell 执行、Docker、HTML 发布、知识检索或外部 Agent 执行。

## 目录

- [使用本包](#use-this-package)
- [所有权与执行](#ownership-and-execution)
- [持久化与生命周期](#persistence-and-lifecycle)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

将 [cordis.patch.yml](cordis.patch.yml) 应用到已提供注入的 Host 服务和 MCP 提供方的 profile。该 patch 只挂载目录服务并设置绝对路径的私有 `workspaceRoot`，不会安装或配置提供方。[Config](src/config.ts) 定义发布、技能、附件分页和报告的上限。`capabilityPreset` 指定部署的技能目录作用域，与创建及运行 preset 分离。

在本人拥有的 selectable/default 对话中，权限为 `workspace-write` 或 `danger-full-access` 时，可使用 `/create-agent [requirements]` 或 `/publish-agent`。尚无已保存草稿时，命令将根据已确认对话提取需求的请求入队，不会发布。检查保存后的名称、描述和 revision，再显式执行 `/publish-agent confirm <revision> <public|private>`。确认直接调用发布，无需另一次模型回合。完全相同的重放返回已有 release；过期或冲突确认失败，不新增 release。结果未知时，重试前先查询目录。

作者也可以通过 `startAuthoring` 打开私有编辑器，通过 `cloud_agent` 保存，或在独立私有 Session 中预览精确草稿 revision。保存时固定 MCP 工具签名和技能指令/资源；选择服务器会在保存时展开其工具。发布使用这些已保存快照并验证当前签名，记录可见范围、来源 Session id/事件序号/preset/权限，并对生效定义与已捕获能力计算摘要。发现操作不能静默扩大已保存草稿或旧 release；签名变化必须再次显式保存并确认。

<a id="ownership-and-execution"></a>
## 所有权与执行

目录返回本人草稿、当前公开或本人拥有的 release，以及仅属于调用者的对话。公开条目不包含其他所有者的来源 Session 审计。新 usage Session 属于启动它的用户而非发布者，并绑定精确 release id。撤回、可见范围变化、新发布或删除后，已有 Session 保留原所有者与 release。使用条目显示 `available`、`updated`、`disabled`、`withdrawn`、`access-lost` 或 `deleted`；这些状态不会重定向已有 Session。

`creationPreset` 和 `runPreset` 必须可选。创建在编辑器中挂载所选 preset。usage Session 只挂载其保留的 release preset：`runPreset` 仅验证并记录，不挂载，因此不能增加工具或权限。可选 provider/model 覆盖值会经过验证。绑定审计记录创建/运行 preset，以及包含 release、run preset、实际模型和强制 `read-only` 权限的生效摘要。运行时只提供批准的 MCP 工具、固定技能、可下载文本报告和本对话文件读取；见[运行时](../cloud-agent-runtime/README.zh.md)。

可选企微资源提供方授予本包的 Remote 操作，以及成员 default Workspace 中精确的 `/create-agent` 和 `/publish-agent` 命令。目录变更提交后会使访问快照失效。Session 所有者从持久化绑定或成员 default Workspace 解析，不从发布所有权推断。创建提供方路由处理当前保留 release；fork 放置负责分配私有文件，保留的绑定事件维持所有权。

<a id="persistence-and-lifecycle"></a>
## 持久化与生命周期

[类型](src/types.ts)和[存储](src/storage.ts)定义持久化 Agent 记录与对话。`cloud-agent/binding` 通过 `companyCloudAgentBinding` 提供可恢复的 Session 所有权与 preset 审计；domain 记录仍是目录的唯一事实来源。保留 Agent Session 缺少所有权证据时拒绝恢复。release 定义不可变；更新推进草稿 revision，删除保留含历史 release 的墓碑记录。

服务串行执行变更，在提交发布前注册保留 preset，并在失败时移除临时注册。Session 准备失败时清理 handle、Workspace 注册和私有文件；回滚失败会聚合报告。卸载等待已跟踪的 MCP 调用，并移除所属 preset、命令和权限 guard。MCP 失败保持为失败，不会成为空成功结果。

<a id="model-experience"></a>
## 模型体验

### 草稿编写工具

#### 模型看到什么

[authoring.ts](src/authoring.ts) 中的 `cloud_agent` schema 与描述，含 catalog、discover、save、preview 和 clone 操作，不含 publish 操作。目录结果含允许的草稿摘要、模型选项和能力名称；save 返回完整草稿、revision 和确认命令。不接受秘密与执行配置字段。

#### Token 影响

工具可见时，其 schema 向提示词增加固定内容。目录/发现结果随允许的选项变化；保存指令受草稿解析器限制。工具调用与结果进入普通 Session 历史。命令入队的提取请求增加一条已记录用户消息，而不是复制整个对话。

#### KV Cache 影响

注册不变时 schema 稳定；目录和工具结果追加历史。preset 或可见工具变化可能替换提示词 token，使原本可复用的前缀失效。仅检查或发布的命令本身不增加模型请求。

### 保留的编写指令

#### 模型看到什么

只有保留的 `cloud-agent-authoring` preset 提供以下字面指引；普通可选编辑器保留自身 preset 提示词。

##### 编写指引原文

```markdown
Help the user refine reusable Agent requirements. Use cloud_agent catalog and save to preserve confirmed instructions and selected MCP tools and skills. Exclude credentials and one-off results. Publication requires the user to confirm the saved revision and visibility with /publish-agent.
```

#### Token 影响

仅组合该保留的编写 preset 时出现固定内容。usage 指令和技能/报告/文件结果由链接的运行时负责，不属于这段指引。

#### KV Cache 影响

该 preset 内重复指引的前缀稳定；切换 preset 会改变提示词。提供方缓存是否可用及其淘汰策略不属于本包职责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 不应用 run preset 中超出验证与审计的行为；reasoning 和展示变化需要独立的能力安全组合设计。
- 知识检索、外部 Agent subagent、可执行插件和 shell 访问不属于这个 MCP 与技能 bundle。
- 不能根据已入队的提取请求推断发布成功。用户必须等待已保存 revision 并显式确认；不确定结果需要查询目录。
- 部署/profile 配置、生成目录、持久化确认记录和 Loader 驱动的录制 Session 属于集成职责；定向 Host fixture 不能证明生产连通性。

<a id="dev-note"></a>
### 开发备注

Remote 资源读取器必须标识请求中的来源或编辑 Session；包级授权不能替代变更操作中的所有者与 revision 校验。新增创建或 fork 路由必须保留这些校验及 release 运行时策略。
