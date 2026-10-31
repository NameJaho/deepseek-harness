---
description: "一次性 Docker 或 Podman 执行容器：每次受限调用只挂载一个已授权的 Session 工作区。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-container

[English](README.md) | 中文

## 概述

在一次性 Docker 或 Podman 容器中运行 Bash、终端和 Node 执行。每次受限调用只把已授权的 Session 工作区挂载到原始绝对路径；容器关闭网络、使用只读根文件系统、不保留 Linux capabilities，并设置 CPU、内存和进程上限。运行时或镜像不可用时，提供方会故障关闭。

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

设置 `DSH_CONTAINER_SANDBOX_IMAGE` 启用 shipped base bundle 中的提供方。启动器也会设置工作区根目录 allow-list；如果部署把工作区存放在 `DSH_BASE/workspaces` 或 `DSH_HOME` 之外，请显式设置 `DSH_CONTAINER_WORKSPACE_ROOTS`。镜像必须提供 Bash 和自身的 Node 运行时。`nodeExecutable` 选择镜像内的 Node；官方 Node 镜像默认使用 `/usr/local/bin/node`。不要把宿主系统可执行文件或库目录挂载进镜像。

```bash
DSH_CONTAINER_SANDBOX_IMAGE=node:24-bookworm
DSH_CONTAINER_RUNTIME=docker
DSH_CONTAINER_WORKSPACE_ROOTS=/srv/dsh/workspaces:/srv/dsh/data
DSH_CONTAINER_READONLY_ROOTS=/srv/dsh/app/packages:/srv/dsh/app/vendor:/srv/dsh/app/node_modules
```

提供方接受 `docker` 或 `podman`，把配置的应用根目录以只读方式挂载，并把 Session 工作区挂载到原始绝对路径，使 PTC 两侧使用相同的工作目录。启动器只挂载仓库的 `packages`、`vendor` 和 `node_modules` 目录，将根目录的环境文件留在容器之外。会话代码能读取配置的只读根目录下的所有文件；只选择包含运行时文件的根目录。`read-only` 在工作区的 `--mount` 选项中添加 `readonly`；`workspace-write` 使用默认的读写绑定挂载。额外可写根目录，以及覆盖镜像系统可执行文件或库目录的挂载都会被拒绝。挂载路径不能包含逗号、双引号或换行。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `runtime` | `docker` | 容器运行时可执行文件。 |
| `image` | 必填 | 每次受限调用使用的镜像。 |
| `nodeExecutable` | `/usr/local/bin/node` | 镜像内安装的 Node 可执行文件。 |
| `workspaceRoots` | `[]` | Session 工作区根目录的必填 allow-list。 |
| `readOnlyRoots` | `[]` | 以只读方式挂载的运行时根目录。 |
| `memory` | `1g` | 容器内存上限。 |
| `cpus` | `2` | 容器 CPU 配额。 |
| `pidsLimit` | `256` | 单个容器的最大进程数。 |
| `probeTimeoutMs` | `5000` | 运行时探测和容器清理的超时毫秒数。 |
| `user` | DSH 服务 uid:gid | 容器内使用的非 root 数字 uid 和 gid；工作区必须由该身份拥有或可写。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

提供方实现 `ctx.sandbox`；现有 Bash、终端和 PTC 消费者继续解析共享的 Session 策略。宿主 runner 使用资源上限和已授权挂载启动 `runtime run --rm --init --network=none --read-only`。镜像使用自身的可执行文件和库。对于 PTC，容器内 runner 把 Docker stdin/stdout 转接到 worker 的专用控制管道；程序诊断输出写入 stderr。连接关闭会终止 worker，宿主 runner 会在客户端退出后显式删除具名容器。每次受限调用都会新建容器，因此进程状态不会跨调用或用户共享。

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

- 提供方支持 POSIX 宿主与 Linux 镜像；尚未实现 Windows 宿主路径转换。
- 容器与宿主共享内核。需要内核级边界时使用 gVisor 或 microVM。
- 容器关闭网络。MCP 和知识库请求仍由 Host 进程发起；容器内程序仍可调用已授权的 PTC Host 工具绑定。
- 镜像必须提供 Node 和兼容的命令程序。随应用文件挂载的宿主原生模块可能需要针对镜像重新构建；提供方不会构建或同步镜像。
- 文件系统工具仍使用现有 Host 策略，不在容器内运行。容器保护代码执行；工作区 allow-list 和 Remote 授权保护直接文件操作。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
