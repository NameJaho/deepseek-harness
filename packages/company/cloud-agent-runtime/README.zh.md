---
description: "字面 release 提示词，以及 Agent 所属的 MCP、知识库、技能、报告和附件策略。"
kind: "package-reference"
---

# @deepseek-ai/dsh-company-cloud-agent-runtime

[English](README.md) | 中文

## 概述

由 [Cloud Agent Host](../cloud-agent/README.zh.md) 消费的作用域 preset 插件。Host 从已保存 release 编译可信配置；本插件不是独立执行提供方，不接受连接设置、凭据或可执行 YAML。

## 目录

- [配置与强制限制](#configuration-and-enforcement)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="configuration-and-enforcement"></a>
## 配置与强制限制

[Config](src/index.ts) 要求字面 `instructions` 和 `releaseId`，可选字段为精确 `mcpTools`、批准的 `knowledgeSources`、固定 `skills` 及 `mode`（默认 `release`）。技能资源包含精确相对路径和 base64 字节。Host 负责持久化验证、能力绑定、快照上限和私有文件写入；运行时调用者必须提供已经 Host 验证的 release 数据。

release 模式在作用域内替换 persona，不插值，并抑制部署运行时上下文。Agent 创建时通过 Host 解析批准的 MCP 包装工具，只为 release 批准的来源注册 `cloud_knowledge`，隐藏全局工具并安装执行 guard。它添加 `cloud_report` 以生成有上限的可下载 UTF-8 报告；仅选择了技能时提供 `cloud_skill`。只有本对话已记录或入队上传，或随后收到文件时，才注册 `cloud_file`；其参数是已记录 attachment id，而非文件系统路径。报告、知识库和文件执行检查接收 Agent 身份。每次模型步骤前，Host 重新验证 MCP 和知识库绑定；失败会停止后续步骤。

authoring 模式只暴露 `cloud_agent`，不能执行 MCP 工具、报告或附件读取。其字面提示词可包含固定技能指令。工具限制与执行 guard 属于 Agent，因此卸载运行时不会在 Agent 仍存活时暴露全局工具；Agent 清理时移除这些策略。运行时不改变部署的工具展示模式。

<a id="model-experience"></a>
## 模型体验

### 字面 persona 与技能列表

#### 模型看到什么

精确的已保存指令。release 模式在字面标题 `Available skills (load instructions with cloud_skill before using them):` 后追加所选技能名称和描述；技能正文仅按需返回。authoring 模式则在 `# Skill: {name}` 下包含每个所选正文。指令中的模板保持字面文本。抑制运行时上下文不会用 Host 文件系统或部署细节替换这些指令。

#### Token 影响

persona 大小取决于经过验证的已保存指令和所选技能。release 列出描述而非插入所有技能正文；加载技能时将完整固定指令或资源字节作为工具结果追加。资源和指令大小在 Host 捕获快照时受限。

#### KV Cache 影响

同一不可变 release 内指令与所选能力稳定。切换 release 或 authoring 模式会改变提示词前缀。按需技能结果追加历史；上传后注册 `cloud_file` 会改变可见 schema 列表，可能使前缀复用失效。

### 作用域工具与结果

#### 模型看到什么

只看到批准的 MCP schema，以及 [index.ts](src/index.ts) 中适用的 `cloud_knowledge`、`cloud_skill`、`cloud_report` 和 `cloud_file` 定义。MCP 描述与参数来自经过签名检查的提供方。知识库结果包含经过验证的段落、文档标题和章节；技能结果包含固定指令或 UTF-8/base64 资源数据；文件结果包含本对话引用或经过验证的分页；报告结果包含可下载报告元数据。不暴露全局 shell 或任意文件访问。

#### Token 影响

每个所选工具的 schema 增加固定文本。提供方结果随调用变化；报告字节数与文本分页大小受 Host 限制。技能和文件调用将结果追加到普通 Session 历史。报告在持久化工具结果元数据中保留完整文本，并使用简短渲染结果。

#### KV Cache 影响

固定能力集保留重复 schema 前缀。上传触发文件工具注册会改变该前缀；工具结果追加历史。提供方缓存分配与淘汰独立于这些策略。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 不提供 shell、Docker、可执行插件或外部 Agent 执行。知识检索仅限保留 release 批准的来源。
- 资源读取返回固定文本或 base64，不授予文件系统访问。附件仅支持经过验证的 UTF-8 分页，不解释二进制内容。
- 本插件信任 Host 编译的 release 配置。直接部署配置不得绕过 Host 的持久化解析器或 release 授权。

<a id="dev-note"></a>
### 开发备注

`tools.restrict` 接受继承的全局工具名称，而非注册在本 Agent 作用域中的工具。新增 release 能力时，必须同时保留作用域注册与执行器授权；仅让 schema 可见并不授予执行权限。
