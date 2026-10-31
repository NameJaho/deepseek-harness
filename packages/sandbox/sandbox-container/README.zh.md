---
description: "一次性 Docker 或 Podman 执行容器：每次受限调用只挂载一个已授权的 Session 工作区。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-container

[English](README.md) | 中文

## 概述

在一次性 Docker 或 Podman 容器中运行 Bash、终端和 Node 执行。每次受限调用只把已授权的 Session 工作区挂载到 `/workspace`；容器关闭网络、使用只读根文件系统、不保留 Linux capabilities，并设置 CPU、内存和进程上限。运行时或镜像不可用时，提供方会故障关闭。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

设置 `DSH_CONTAINER_SANDBOX_IMAGE` 启用 shipped base bundle 中的提供方。启动器也会设置工作区根目录 allow-list；如果部署把工作区存放在 `DSH_BASE/workspaces` 或 `DSH_HOME` 之外，请显式设置 `DSH_CONTAINER_WORKSPACE_ROOTS`。镜像必须包含所选消费者使用的可执行文件路径，包括 Bash 和 PTC 使用的 Node 运行时。

```bash
DSH_CONTAINER_SANDBOX_IMAGE=node:24-bookworm
DSH_CONTAINER_RUNTIME=docker
DSH_CONTAINER_WORKSPACE_ROOTS=/srv/dsh/workspaces:/srv/dsh/data
DSH_CONTAINER_READONLY_ROOTS=/srv/dsh/app
```

提供方接受 `docker` 或 `podman`，把配置的只读运行时根目录按原路径挂载，并把 Session 工作区挂载到 `/workspace`。测试启动器会把宿主 Node 可执行文件目录加入只读根目录，因为 PTC 会在沙箱包装调用前解析可执行文件。`read-only` 以只读方式挂载工作区；`workspace-write` 以读写方式挂载。额外可写根目录会被拒绝，因为每次容器必须只有一个明确的工作区挂载。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `runtime` | `docker` | 容器运行时可执行文件。 |
| `image` | 必填 | 每次受限调用使用的镜像。 |
| `workspaceRoots` | `[]` | Session 工作区根目录的必填 allow-list。 |
| `readOnlyRoots` | `[]` | 以只读方式挂载的运行时根目录。 |
| `memory` | `1g` | 容器内存上限。 |
| `cpus` | `2` | 容器 CPU 配额。 |
| `pidsLimit` | `256` | 单个容器的最大进程数。 |
| `user` | DSH 服务 uid:gid | 容器内使用的非 root 数字 uid 和 gid；工作区必须由该身份拥有或可写。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

提供方实现 `ctx.sandbox`；现有 Bash、终端和 PTC 消费者继续解析共享的 Session 策略。它生成 `runtime run --rm --init --network=none --read-only`，随后加入资源上限、capability 丢弃、只读运行时挂载、唯一 Session 工作区挂载、镜像和原始 argv。Session id 会写入容器 label，便于运维检查。每次受限调用都会新建容器，因此进程状态不会跨调用或用户共享。

提供方在服务就绪前检查运行时，并在创建 argv 前检查工作区是否位于配置的物理根目录 allow-list 内。容器运行时失败会报告 `SANDBOX_UNAVAILABLE`；不支持的额外挂载会报告 `SANDBOX_UNSUPPORTED_POLICY`。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [进程沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——共享策略与强制执行事实。
- [本地沙箱提供方](../sandbox-local/README.zh.md)——宿主机 bwrap、Landlock、Seatbelt 和 Windows ACL 后端。
- [沙箱服务](../sandbox/README.zh.md)——提供方接口与升权词汇。

<a id="model-experience"></a>
## 模型体验

### 容器执行

#### 模型看到什么

现有 Bash、终端和 `run_code` 工具报告沙箱模式、强制执行级别、拒绝或运行时不可用错误。本提供方不增加工具或提示词段落。

#### Token 影响

容器状态通过现有工具结果传递，不增加固定提示词贡献。

#### KV Cache 影响

本提供方不改变工具 schema 或提示词段落。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 容器与宿主共享内核。需要内核级边界时使用 gVisor 或 microVM。
- 容器关闭网络。MCP 和知识库请求仍由 Host 进程发起，容器内代码不能直接访问。
- 镜像必须提供兼容的可执行文件路径和运行时库；提供方不会构建或同步镜像。
- 文件系统工具仍使用现有 Host 策略，不在容器内运行。容器保护代码执行；工作区 allow-list 和 Remote 授权保护直接文件操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
