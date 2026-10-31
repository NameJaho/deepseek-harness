# Login 分支功能迁移与优化交接方案

[English](login-branch-migration-plan.md) | 中文

本文是给后续执行 AI 的实现参考。目标是在 `login` 分支保留现有企微登录和成员隔离行为，并从 `master` 迁入品牌、Cloud Agent 的 MCP 能力和企业知识库能力。本文描述迁移范围、代码落点、外部接口约束、界面优化、测试和回滚要求。本文是实施计划，不代表功能已经在 `login` 分支完成。

## 目录

- [一、分支现状和总体策略](#1-branch-state-and-strategy)
- [二、功能边界](#2-scope)
- [三、执行顺序](#3-execution-order)
- [Cloud Agent 产品流程与工作区围栏](#cloud-agent-product-flow-and-workspace-fence)
- [四、品牌和本地构建名称](#4-brand-and-local-build-naming)
- [五、MCP 能力迁移](#5-mcp-capability-migration)
- [六、企业知识库迁移](#6-company-knowledge-migration)
- [七、Logo 迁移](#7-logo-migration)
- [八、测试和验收](#8-tests-and-acceptance)
- [九、风险、回滚和交付物](#9-risks-rollback-and-deliverables)
- [十、给执行 AI 的检查清单](#10-ai-execution-checklist)

<a id="1-branch-state-and-strategy"></a>
## 一、分支现状和总体策略

`master` 与 `login` 从同一个历史点分叉。`master` 后续加入了 `packages/company/cloud-agent`、`packages/company/cloud-agent-runtime`、`packages/company/knowledge` 以及企业 MCP 目录；`login` 后续加入了企微浏览器登录和成员工作区隔离。当前工作区还有未提交的企微认证文件和本地目录，执行迁移前必须先保存这些改动，不能用 reset、clean 或整分支覆盖的方式清理工作区。

先运行以下只读检查，记录基线，不要直接合并整个 `master`：

```sh
git status --short --branch
git merge-base master login
git diff --stat login...master
git log --oneline --reverse master -- packages/company
```

`master` 与 `login` 的全量差异包含大量与本任务无关的上游改动。正确策略是以 `master` 的功能提交为参考，按文件和依赖迁移到 `login`，每一阶段都在 `login` 上编译和测试。不要直接执行 `git merge master`，也不要把 `master` 的 `pnpm-lock.yaml`、全部 snapshots 或整套部署脚本覆盖到 `login`。

迁移应分成四个可回滚阶段：先做品牌基线，再接入 Cloud Agent 基础和外部 MCP seam，然后接入知识库，最后替换 Logo 并做整体视觉收口。每个阶段完成后建立一个独立提交；任何阶段失败时只回滚该阶段，不影响企微认证改动。

<a id="2-scope"></a>
## 二、功能边界

### 本次必须迁入

1. 将首屏文案“探索未至之境”改为 `HMWORK`，并把本地构建的标题、侧栏品牌名、启动页 wordmark 和 PWA 名称统一为 HMWORK 体系。
2. 迁入 Cloud Agent 的草稿、发布版本、会话绑定和能力选择框架，使 MCP 工具可以按 Agent 选择并在发布版本中固定。
3. 迁入 MCP 的管理和展示体验，包括能力侧栏、工具列表、工具 schema 查看、连接状态、加载和错误状态。
4. 迁入企业知识库的 Host 端检索、来源选择、发布版本权限指纹、`cloud_knowledge` 工具和管理页。
5. 使用用户提供的两人卡通图作为 HMWORK Logo，在侧栏、首屏、启动页和浏览器安装图标中保持一致的裁切和清晰度。
6. 在任意 default workspace 对话中提供“发布 Agent”Command，将当前对话的配置发布为线上 Agent，并在 Cloud Agent 页面列表显示。
7. 允许用户 B 使用用户 A 发布的 Agent；使用后在 B 的界面新增一个以 Agent 名称命名的工作区，并让同一 Agent 的后续对话复用该工作区。
8. 创建 Agent 和运行同一个 Agent 都可以选择不同的 mode preset；release 的能力快照与运行时 preset 必须分别记录。
9. 允许对话通过 subagent 调用已在 Dify 或其他平台上线的外部 Agent，并记录外部调用的输入、状态、输出和失败。
10. Agent 工作区右侧提供 Agent 信息栏目和 Agent 能力栏目；能力栏目只显示该 Agent 的 MCP、知识库和 Agent 专属插件，不显示全局插件。
11. 在 Agent 能力栏目中选择、接入或移除 MCP 和知识库；修改已发布 Agent 时必须产生新的草稿或 release，不得改变旧 release。

### 本次明确不迁入

1. 不迁入 `master` 的完整 MCP 目录后端和目录数据源。旧 Cloud Agent MCP 目录实现及 `company-mcp-catalog` 配置行不是本次交付物。
2. 不在浏览器中收集 MCP endpoint、Bearer token 或 credential reference。后续 MCP 数据由其他接口提供，前端只消费脱敏后的服务器、工具和状态数据。
3. 不迁入 HTML 应用发布、企微机器人、Dify 项目执行、Docker 沙箱优化等与本任务无关的公司功能。若 Cloud Agent 基础代码依赖这些包，先保留依赖但不要在 `login` 的 profile 中挂载它们；后续再单独拆分。
4. 不把知识库页面伪装成“文档上传或建库”页面。当前能力只做已配置知识空间的检索和证据展示，入库、索引和空间管理由外部知识服务负责。

### 迁移后的责任分层

| 层 | 责任 | 不应承担的责任 |
| --- | --- | --- |
| Web Client | 展示品牌、来源、工具、证据和状态；提交逻辑 id 与查询 | 保存 endpoint、token、空间真实 id |
| Host Plugin | 校验配置、调用外部接口、过滤响应、维护生命周期 | 把未知失败转换成空结果 |
| Cloud Agent | 保存草稿和发布版本的能力选择，执行前校验绑定 | 让模型自行决定未授权来源或工具 |
| 外部 MCP 接口 | 返回 MCP 服务器和工具目录，按请求执行工具 | 依赖 DSH 内部存储格式 |
| 外部知识接口 | 返回已授权空间的检索证据 | 由 DSH 负责建库或导入文档 |

<a id="3-execution-order"></a>
## 三、执行顺序

### 阶段 0：建立干净基线

将当前 `login` 工作区未提交内容保存到临时分支或补丁文件，至少包含 `packages/company/wecom-auth/src/index.ts`、`packages/company/wecom-auth/src/types.ts`、`packages/company/wecom-auth/src/account-page.ts` 以及 `.local/`、`.qoder/` 的本地状态。确认保存后，使用独立 worktree 或临时分支实施迁移，避免修改用户当前认证工作。

阅读 `docs/architecture.md`、`docs/defensive-patterns/README.md`、`packages/AGENTS.md` 和涉及包的 README。先确认当前 `login` 的 TypeScript project references、包版本和 `cordis.patch.yml` 结构，再决定是否采用某个 `master` 提交的内容。

### 阶段 1：品牌文字和构建变量

先只改文案和品牌变量，不引入公司包。为 `DSH_CLIENT_TITLE` 规定唯一默认值 `HMWORK`，让首屏 Hero、侧栏品牌名和启动页均读取同一个值。生产或测试环境仍可通过环境变量覆盖，但文档、截图和快照默认使用 HMWORK。

这一阶段完成后应能在不挂载 Cloud Agent 的情况下启动 Web，确认中文首屏不再出现“探索未至之境”，页面标题和侧栏不再显示“DSH Local Build”或“DeepSeek Harness”作为产品名。

### 阶段 2：Cloud Agent 基础和外部 MCP seam

从 `master` 的“支持云智能体发布与企业 MCP 调用”功能提交迁移 Cloud Agent 的最小基础，再迁移“Agent capability sidebar”和“select MCP services per Agent”提交中的类型、选择器和侧栏部分。不要顺手合并 `master` 的其他上游改动。

先定义外部 MCP 提供方接口和 Agent 发布 seam，再把 Cloud Agent 从具体的 `CompanyMcpService` 解耦。只有 provider、发布命令、用户间授权和工作区规则稳定后，才接入页面和发布逻辑。这样后续替换 MCP 数据接口只需改一个 Host adapter，不需要再次修改 Agent 发布和 Web UI。

### 阶段 3：知识库 Host、运行时和页面

迁移 `packages/company/knowledge` 的 HTTP 检索和验证逻辑，以及 `cloud-agent-runtime` 的 `knowledgeSources`、`cloud_knowledge` 工具和发布前绑定校验。暂不迁入知识库的 MCP transport 分支；如果后续外部接口确实采用 MCP，再单独增加一个实现 `KnowledgeProvider` 的 adapter。

先用本地 fixture 验证响应校验、空间隔离、超时和空结果，再接入真实地址。最后再改知识库页面的布局和文案，避免在协议尚未稳定时反复调整 UI。

### 阶段 4：Logo、图标和整体验收

把用户提供的图片处理成 Web 资源，接入品牌 slot 和 PWA 图标生成流程。完成视觉检查后，重新录制品牌、MCP 和知识库相关快照，执行 `build:artifacts`、`build:check` 和针对性测试。

<a id="cloud-agent-product-flow-and-workspace-fence"></a>
## Cloud Agent 产品流程与工作区围栏

### 从普通对话发布 Agent

在每个 default workspace 的普通对话中注册“发布 Agent”Command。Command 只能读取当前会话已经确定的配置：有效的 provider、model、mode preset、系统指令、已批准的 MCP、知识库、插件和权限摘要；它不能把 token、endpoint、临时文件路径或未记录的浏览器状态写入 release。

Command 执行时先创建或更新 Agent 草稿，再要求用户确认名称、描述和公开范围，最后调用发布操作生成不可变 release。release 保存来源会话 id、来源事件序号、配置摘要、能力绑定指纹和创建时间。发布成功后 Cloud Agent 页面通过现有 catalog/follow 流显示该 Agent；发布失败或结果未知时保留草稿并要求查询状态，不重复创建 release。

### 跨用户使用和一个 Agent 一个工作区

用户 A 发布的 Agent 进入可见目录后，用户 B 只能通过授权后的“使用 Agent”操作启动它。Host 根据 B 的 owner scope 和 Agent 的公开策略创建 usage Session，并把该 Session 绑定到精确的 release id。B 的客户端为该 Agent 创建一个 workspace navigation group，标题使用 Agent 名称；该 group 的稳定 key 必须由 Agent id 派生，而不是由会话 id 派生。

同一个用户再次使用同一个 Agent 或从该 Agent 工作区新建对话时，复用同一个 Agent workspace group，不新增第二个工作区。新建的只是该 workspace 下的普通 Session，并继续绑定同一个 release 或用户选择的新 run preset。普通 default workspace、Agent authoring workspace 和外部 Agent subagent workspace 仍然彼此独立。

删除 Agent、撤回 release、用户失去访问权或 Agent 被禁用时，导航组显示明确状态；已有 Session 仍按持久化 owner 和 release 规则恢复，不能因为目录刷新而指向新的 Agent。工作区名称变化需要显式迁移记录，不能用标题匹配猜测归属。

### 创建 preset 与运行 preset

Agent 的内容和能力 release 与运行 preset 分离。创建时可选择一个 creation preset，用于决定 authoring Session 的工具、system prompt、权限和模型默认值；这些值写入来源会话和发布审计，但不能覆盖 release 的安全限制。

运行同一个 Agent 时，用户可以选择另一个 run preset。run preset 只决定当前 Session 的 provider、model、reasoning、权限和可选展示，不得增加 release 未批准的 MCP、知识库、插件或文件能力。每次运行记录 Agent id、release id、creation preset、run preset 和实际生效配置摘要，恢复和审计使用相同字段。

### 外部 Agent 作为 subagent

为 Dify 及其他平台增加独立的 `ExternalAgentSubagentProvider`，不要把外部 Agent 伪装成 DSH MCP 工具。provider 配置保存平台、逻辑 Agent id、版本或环境、认证引用、超时、输入输出上限和是否允许继续对话；浏览器只看到逻辑名称和状态。

父对话调用 subagent 时创建标准 subagent descriptor/catalog 记录，记录外部 Agent、父 Session、调用参数摘要、开始状态、完成状态、输出引用和错误。外部响应必须经过大小、编码和状态校验；超时、未知结果和部分响应保持失败，并在父 Session 中显示可恢复的失败信息。外部 Agent 不得继承父 Session 的 shell、MCP、知识库或全局插件权限，除非 provider 明确声明并通过 release policy 授权。

### Agent 信息和 Agent 能力侧栏

Agent 信息栏目展示当前 Session 使用的 Agent 名称、owner 或公开来源、release 版本、创建和运行 preset、provider/model、当前状态、调用链链接、最近一次输出摘要和可继续的 Session。长链接或内部路由使用复制按钮和安全的截断展示，不直接显示 token、内部 endpoint 或完整 prompt。

Agent 能力栏目只读取当前 Session 的 release 投影，展示该 Agent 实际能调用的 MCP、知识库和 Agent 专属代码插件。全局插件、部署级工具和其他 Agent 的能力不出现在此列表中。authoring Session 可以在此选择、接入或移除 MCP 和知识库；usage Session 的编辑按钮必须先创建一个受控编辑 Session 或新草稿，保存后由用户显式发布新 release。

能力栏目中的添加、移除和发布操作都要使用 Agent id、草稿 revision 和 release id 做并发校验。刷新目录不能自动把新 MCP 或知识库加入 Agent；删除能力不能影响已运行的旧 Session，旧 Session 继续使用其固定 release。

<a id="4-brand-and-local-build-naming"></a>
## 四、品牌和本地构建名称

### 当前代码落点

`master` 已经在 `packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx`、`packages/client/ui-sidebar/src/client/SidebarRoot.tsx` 和 `packages/client/web/src/boot-page.ts` 使用 `process.env.DSH_CLIENT_TITLE`。`login` 仍有部分位置直接使用本地化的 `hero.headline`、`brand.localBuild` 或 `HARNESS`，需要统一处理。

`packages/client/ui-conversation/src/client/locales.ts` 的 `hero.headline` 是语言回退值；它可以改成 `HMWORK`，但组件仍应保留 `DSH_CLIENT_TITLE` 覆盖能力。不要把部署名称写死进通用包的其他技术文案。

### 建议的品牌值

| 位置 | 默认值 | 说明 |
| --- | --- | --- |
| 首屏 Hero | `HMWORK` | 替换“探索未至之境” |
| 侧栏本地构建名 | `HMWORK` | 若有版本号，显示为 `HMWORK` 加版本徽标 |
| 启动页 wordmark | `HMWORK` | 替换 `HARNESS` |
| 浏览器 `<title>` | `HMWORK` | 可在开发环境追加 `本地构建`，但不再显示 DSH Local Build |
| PWA `name` | `HMWORK` | `short_name` 使用 `HMWORK` |
| Shell 启动器 | `DSH_CLIENT_TITLE=HMWORK` | 允许环境变量覆盖，不把代理配置写入仓库 |

### 实现要求

1. 使用一个品牌配置或环境变量作为来源，避免在 Hero、Sidebar、BootPage、`index.html` 和 manifest 各写一套字符串。
2. `DSH_CLIENT_TITLE` 的值必须经过现有构建注入流程；不要在浏览器运行时读取服务器私密环境变量。
3. 旧快照中对“探索未至之境”的断言必须改为 HMWORK，同时保留预览版徽标、无障碍名称和响应式布局断言。
4. 品牌变更只影响展示，不改变包名、profile 名、Session 事件、API 路径或持久化字段。不要为了换名修改 `@deepseek-ai/*` 包名。
5. 如果通用品牌 slot 已由 `ui-brand-official` 占用，优先新增 HMWORK 的品牌 occupant 或在 login profile 中替换 occupant，不要直接改写通用 `FishLogo`，以免影响其他 profile 和共享组件。

<a id="5-mcp-capability-migration"></a>
## 五、MCP 能力迁移

### 需要保留的用户能力

用户需要在 Agent 维度查看和选择 MCP 能力。迁移后的流程是：外部接口返回可用 MCP 服务器和工具摘要，作者在 Agent 能力侧栏选择服务器或工具，草稿保存选择，发布时固定当前工具 schema 指纹，运行时只注册该 release 允许的工具。旧 release 的选择不能被目录刷新静默替换。

应保留 `master` 中这些与用户体验和 Agent 绑定有关的部分：`packages/company/cloud-agent/src/client/capabilities.tsx`、`src/client/mcp-list.tsx`、`src/client/agent-mcp.ts`、`src/client/mcp-controller.ts`、`src/client/mcp-page.tsx` 的展示逻辑，以及 `CloudAgentDraft`、`CloudAgentRelease`、`CloudAgentCapabilities` 中的 MCP 选择字段。具体文件可能因 `login` 的上游版本不同而需要手工适配，不能直接覆盖同名文件。

### 必须替换的后端 seam

新增一个 Host 侧 `CompanyMcpProvider` 能力接口，建议至少包含以下方法：`catalog()` 返回脱敏服务器摘要，`follow(signal)` 推送目录或状态变化，`configure()` 只保存启用状态而不保存凭据，`discover(id)` 返回工具 schema，`discoverTools(id)` 返回用于发布的工具摘要，`resolveTool(name)` 返回当前 schema 和执行函数，`describeTool(name)` 返回外部网关所需的非秘密路由信息。

`CloudAgentService` 和 `capabilityCatalog()` 只依赖这个接口，不直接依赖目录 HTTP、MCP SDK 或 credential store。若当前代码通过 `ctx.companyMcp` 注入，改成注入 `ctx.companyMcpProvider`，或提供一个兼容接口的 adapter；不要让 `CloudAgentService` 同时保留两套真实执行路径。

外部 MCP 接口至少应返回以下字段：稳定服务器 id、显示名称、描述、启用状态、连接状态、工具名、工具描述和参数 JSON Schema。服务器 endpoint、访问令牌、内部供应商字段和用户无关的目录数据不得下发浏览器。服务器 id 应按项目已有的 branded id 规则处理，不能在跨边界类型中使用裸 `string`。

### 明确删除或不引入的内容

不迁移旧 Cloud Agent MCP 目录实现中的目录刷新、远端连接、MCP session 初始化、本地连接缓存、目录协议解析和 mock 数据，也不在 `cordis.patch.yml` 中挂载 `company-mcp-catalog`。如果为了兼容已有类型暂时保留目录文件，必须从构建入口、profile patch 和运行时依赖图中移除，并添加 TODO 说明删除时间。

MCP 页面不再显示 credential reference 输入框、目录来源 URL 或“连接到目录”的按钮。页面改为消费外部提供方的状态，连接失败只显示可恢复的错误和重试操作，不向用户暴露内部 endpoint 或 token。

### MCP 界面优化

1. 顶部提供搜索框、当前筛选条件和刷新按钮；搜索匹配服务器名称、描述、工具名称和工具描述。
2. 服务器使用卡片或分组列表展示名称、用途、状态、工具数量和更新时间。将“可用、连接中、失败、维护中”使用文字和颜色双重表达，不能只依赖颜色。
3. 工具详情默认收起，展开后先显示参数表，再提供完整 JSON Schema 的复制入口。超长描述和 schema 在窄屏中换行，不撑破页面宽度。
4. 草稿能力侧栏展示“已选服务器”和“已选工具”的数量及来源；发布版本只读展示固定选择，目录缺少描述时仍保留已保存的工具名。
5. 所有请求需要禁用重复提交。目录加载、发现工具、保存选择和刷新失败时保留上一次成功数据，并提供明确的重试按钮。
6. 移动端保持单列布局，按钮和复选框满足触摸尺寸，侧栏打开和关闭不会改变当前会话。更新快照时同时覆盖中文和英文。

### MCP 运行时安全要求

发布前校验选中的服务器和工具仍存在、启用状态没有变、schema 指纹与发布时一致。运行前再次校验 release 绑定；发现工具变更时失败并提示重新发现和发布，不自动执行新工具。

工具执行结果必须继续通过 Session 的工具结果记录进入模型上下文。外部 API 的未知状态、超时、连接失败和响应校验失败都保持为失败；不能用空工具列表或空文本伪装成功。

<a id="6-company-knowledge-migration"></a>
## 六、企业知识库迁移

### 从 `master` 迁移的能力

迁移 `packages/company/knowledge` 的 Host 服务、配置、类型、边界解析和客户端 controller/page，并迁移 `packages/company/cloud-agent-runtime` 的 `knowledgeSources` 配置、`cloud_knowledge` 工具和 system prompt 提示。`packages/company/cloud-agent/src/types.ts` 需要保留 `knowledgeSources`、`knowledgeBindings` 和来源摘要字段；发布时保存空间授权指纹，运行前调用 `validate()`。

知识服务的最小外部 HTTP 请求可以沿用 `master` 的协议：请求体包含 `query`、`space_ids`、`top_k`、`mode: hybrid` 和 `rerank: true`；响应包含 `results` 和 `total_hits`，每条结果包含 chunk id、document id、标题、面包屑、完整内容、score 和 space id。最终实现应以实际外部接口为准，并把协议适配限制在 `search.ts` 或独立 provider 中。

### 推荐的接口和安全策略

Host 配置保留逻辑来源 id、显示名称、描述、外部 URL、私有 headers、允许的空间列表、topK、最小相关度、超时和最大响应字节数。浏览器和模型只能看到来源 id、名称、描述及已校验的证据，不能看到 URL、headers、token 或真实空间 id。

每次检索都必须验证完整响应，在允许空间内过滤，去重相同内容，应用最小 score，限制 topK 和响应字节数。空结果表示没有可靠证据，不表示空间存在；网络失败、HTTP 错误、超时、非法 JSON、跨空间结果和超限响应都必须是结构化失败。

`master` 的知识包同时支持 HTTP 和 MCP transport。本次先迁移 HTTP provider，因为后续 MCP 数据会由其他接口提供；不要把知识库再次嵌套到 MCP 目录实现中。若外部知识服务只暴露 Streamable HTTP MCP，再新增一个独立的 `KnowledgeProvider` adapter，并复用同一套证据模型和错误码。

### 知识库页面优化

当前 `KnowledgePage` 是一个简单的来源下拉框、输入框和证据列表。迁移时改为“来源卡片 + 检索面板 + 证据结果”三段式布局：

1. 来源卡片显示名称、用途说明、是否可用和最近一次检索状态；不显示内部 URL、空间 id 或请求 header。
2. 检索面板提供清晰的问题输入、字符计数、提交中状态、取消或重试入口。提交按钮在空问题、超长问题和请求中状态下正确禁用。
3. 结果区使用证据卡片显示文档标题、章节路径、相关度和完整段落。相关度同时显示数值和进度样式，并提供复制证据文本操作。
4. 空结果、未配置来源、加载失败、检索失败和超时使用不同的文案和视觉状态。失败状态保留上一次成功结果，避免页面闪成空白。
5. 结果较多时使用折叠或分页，避免一次渲染过大的 `<pre>`；长文本使用换行和最大高度，移动端不产生横向滚动。
6. 页面底部明确说明当前只支持检索，文档导入和知识空间管理需要外部服务接口。不要提供看起来可以上传建库但实际上无效的按钮。
7. 页面所有文案进入 `locales.ts`，同时提供中英文，使用句首大写英文文案和现有 locale 注入方式。

### Cloud Agent 中的知识体验

Agent 草稿能力侧栏显示可选知识来源及描述；发布版本只读显示已批准来源。`cloud_knowledge` 工具参数只接受来源逻辑 id 和自然语言问题，不能接受 URL、空间 id 或 token。工具说明要求模型引用文档标题和章节，并在空结果时明确说明缺少证据。

当来源空间授权变化时，旧 release 的指纹校验必须失败并要求重新发布；同一空间内文档内容更新不要求重新发布。未选择知识来源的旧 release 不应因为插件安装而自动获得知识工具。

<a id="7-logo-migration"></a>
## 七、Logo 迁移

### 资源处理

把用户提供的两人卡通图片保存为一个受版本控制的源文件，例如 `apps/web/public/brand/hmwork-source.png`。源文件保留原始分辨率；另行生成用于界面和 PWA 的小尺寸资源。不要直接把临时附件路径写入代码，也不要把带有不可见大面积白边的原图直接缩放到 24px。

建议生成以下资源：`hmwork-mark-24.png`、`hmwork-mark-34.png`、`hmwork-mark-192.png`、`hmwork-mark-512.png`、`hmwork-maskable-512.png` 和 `hmwork-apple-touch.png`。小图使用居中裁切和透明或纯色背景，保证两个人物和红蓝黄主色在浅色和深色主题中都可辨认；maskable 图标预留安全区，避免头像和手势被系统裁切。

如果仓库现有 `apps/web/scripts/render-app-icons.ts` 可复用，则把源图接入该脚本并更新对应测试；否则新增一个只负责裁切、缩放和输出的脚本，不在运行时动态处理图片。检查所有输出的尺寸、颜色模式、文件大小和透明度。

### 接入位置

优先通过 `sidebar.brand.mark` 和 `conversation.hero.brand.mark` 两个已有 slot 提供 Logo。建议新增一个 HMWORK brand client plugin，在 `login` 的 Web profile 中替换官方品牌 occupant；它只负责图像和品牌名，不改变 `ui-sidebar`、`ui-conversation` 的通用 fallback。启动页 `BootPage` 和 `apps/web/index.html` 的 favicon、manifest 单独引用生成后的静态资源。

侧栏展开态、收起态、首屏 Hero、启动页、浏览器标签页、PWA 安装图标和桌面快捷方式都要检查。Logo 是装饰图形时提供合适的空 alt 或由旁边的品牌名称承担可访问名称；如果 Logo 是唯一可见品牌标识，则为按钮保留现有 aria-label。

<a id="8-tests-and-acceptance"></a>
## 八、测试和验收

### 品牌验收

- `packages/client/ui-conversation` 的 Hero 测试确认默认文案为 HMWORK、预览版徽标仍存在、环境变量覆盖有效。
- `packages/client/ui-sidebar` 测试覆盖展开和收起两种 Logo、带版本号和无版本号的本地构建名。
- `packages/client/web` 的 BootPage 测试确认启动页 wordmark 为 HMWORK。
- Web PWA 测试确认 `<title>`、manifest `name`、`short_name` 和 icon 引用一致。
- 在浅色、深色、窄屏和高缩放环境下人工检查 Logo 不变形、不溢出、不遮挡新建会话按钮。

### Cloud Agent 产品验收

- default workspace 的普通对话可以发现“发布 Agent”Command；发布前有名称、描述和公开范围确认，发布后 Cloud Agent 列表能看到精确 release。
- 用户 A 发布后，用户 B 可以通过“使用 Agent”启动会话；B 的导航只创建一个以 Agent id 为稳定 key 的工作区，连续新建对话不会增加第二个工作区。
- 创建 preset 和运行 preset 的组合会进入审计和 Session 投影；运行 preset 不能越过 release 的 MCP、知识库、插件或文件权限。
- Dify 或其他平台的 external subagent 能记录 descriptor/catalog、输入摘要、进行中状态、最终输出和错误；超时和未知结果不会显示为成功。
- Agent 信息侧栏展示 owner、release、preset、provider/model、调用链、状态和输出摘要；Agent 能力侧栏只显示本 Agent 的 MCP、知识库和专属插件。
- authoring Session 可以添加或移除能力，usage Session 必须先创建受控编辑草稿；旧 release 和已运行 Session 不因目录刷新或能力删除而改变。

### MCP 验收

- 外部 MCP adapter 的 fixture 覆盖目录成功、目录字段缺失、重复服务器 id、工具 schema 非法、连接失败、超时、刷新失败保留旧数据和 dispose 等情况。
- Cloud Agent 单元测试确认草稿选择、发布绑定、schema 指纹、工具变更拒绝、旧 release 不受新目录影响。
- Client 测试覆盖搜索、状态标签、工具 schema 展开、复制、空列表、加载失败、重试和移动端宽度。
- Session snapshot 确认只有 release 选择的 MCP 工具进入 system prompt 和工具 schema；外部接口凭据和 endpoint 不出现在日志或模型输入中。

### 知识库验收

- HTTP fixture 覆盖跨空间结果、重复内容、低分结果、空结果、响应超限、非法 JSON、HTTP 错误、超时和服务释放。
- Cloud Agent 测试确认知识来源选择进入草稿和 release，指纹变化阻止旧 release 执行，未选择来源时不注册 `cloud_knowledge`。
- Client 测试覆盖来源加载、检索中、无结果、失败保留旧结果、证据卡片折叠和移动端布局。
- Keyless recorded-session snapshot 覆盖知识工具 schema、system prompt 中的来源提示和一次完整证据结果。真实知识服务连通性另做集成检查，不把本地 fixture 当作生产可用证明。

### 必须运行的仓库检查

按当前 `login` 的 package scripts 选择最小相关命令，至少执行：

```sh
pnpm install --frozen-lockfile
pnpm run build:artifacts
pnpm run build:check
pnpm run test:docs
pnpm run test -- packages/company/knowledge packages/company/cloud-agent packages/client/ui-conversation packages/client/ui-sidebar packages/client/web
pnpm run lint
git diff --check
```

如果包尚未加入 `login` 的 workspace，先更新 workspace、TypeScript references、包清单和 lockfile，再运行构建。不要以跳过失败测试的方式完成迁移。涉及产品用户可见行为的变更必须更新对应 keyless snapshot；修改 snapshots 前先确认 fixture 反映真实行为。

<a id="9-risks-rollback-and-deliverables"></a>
## 九、风险、回滚和交付物

### 主要风险

1. `master` 的 Cloud Agent 代码依赖较新的 Session、Remote、storage 或 client slot 类型，直接复制会造成大量类型冲突。解决方法是按当前 `login` 的类型和构建面适配，不要把无关上游提交一起带入。
2. MCP 目录实现与用户计划的外部接口职责重叠。若保留两套 provider，可能出现工具重复注册、凭据来源不一致和 release 指纹失效。迁移完成后只能有一个实际执行 provider。
3. 知识库响应可能包含未授权空间或内部字段。Host 必须完整校验后再返回证据，不能让 UI 或模型承担安全过滤。
4. Logo 原图可能包含白边和过大尺寸。必须通过脚本生成各尺寸资源，并在真实浏览器和 PWA manifest 中验证。
5. 用户当前未提交的企微认证改动可能被冲突解决覆盖。每次冲突解决后重新检查 `git diff -- packages/company/wecom-auth`。

### 回滚原则

品牌、MCP adapter、知识库和 Logo 各自独立提交。回滚 MCP 时保留 Cloud Agent 基础和知识库；回滚知识库时删除 profile mount、能力字段和 `cloud_knowledge`，已有不带知识绑定的 Agent 数据仍可读取。回滚 Logo 时恢复原品牌 occupant 和 favicon 资源，不删除用户上传源文件，除非明确要求。

### 交付物

1. `login` 分支上的分阶段代码提交和每阶段测试记录。
2. 外部 MCP 接口的请求、响应、错误和状态字段说明；其中必须明确哪些字段不会进入浏览器和 Session 日志。
3. 外部知识接口的请求、响应、空间授权和错误字段说明。
4. HMWORK Logo 源图、生成脚本、各尺寸输出和图标验收截图。
5. 更新后的中英文 locale、MCP/知识库/品牌 snapshots，以及构建和测试命令输出。

<a id="10-ai-execution-checklist"></a>
## 十、给执行 AI 的检查清单

- [ ] 保护当前 `login` 工作区未提交的企微认证和本地目录。
- [ ] 记录 `master`、`login`、merge-base 和当前 package version，不执行整分支 merge。
- [ ] 先完成 `DSH_CLIENT_TITLE=HMWORK`、首屏文字和本地构建名称。
- [ ] 通过 slot 接入 HMWORK Logo，不直接修改共享 `FishLogo`。
- [ ] 在 default workspace 注册“发布 Agent”Command，并将配置、权限和发布结果写入可审计的 release。
- [ ] 实现跨用户使用、一个 Agent 一个工作区、创建/运行 preset 分离和外部 Agent subagent provider。
- [ ] 完成 Agent 信息和 Agent 能力侧栏，隐藏全局插件并保护旧 release。
- [ ] 将 Cloud Agent 的 MCP 依赖改为外部 `CompanyMcpProvider`，不挂载 `company-mcp-catalog`。
- [ ] 删除或隔离目录刷新、MCP session 初始化、mock directory 和 credential reference UI。
- [ ] 保留 Agent 能力选择、发布绑定、schema 指纹、Session 记录和错误恢复。
- [ ] 迁移知识库 HTTP provider、来源指纹和 `cloud_knowledge`，默认不迁移知识库 MCP transport。
- [ ] 优化知识库页面的来源、检索、证据、空状态、失败状态和移动端布局。
- [ ] 生成并验证 Logo、favicon、PWA icon 和 manifest。
- [ ] 更新中英文 locale、单元测试、e2e、snapshot 和文档。
- [ ] 在最新代码上运行 `build:artifacts` 后再运行 `build:check`，最后检查 `git diff --check`。
- [ ] 汇总外部接口待确认项，再开始真实环境联调；没有接口样例时不要猜字段或默认值。

## Dev Note

如果后续确认 MCP 和知识库都由同一个企业网关提供，仍保持两个独立 provider：MCP provider 负责工具目录和工具执行，Knowledge provider 负责证据检索和空间校验。共享 HTTP、认证和超时辅助函数可以放在公司基础包中，但不能让一个 provider 直接读取另一个 provider 的内部配置。
