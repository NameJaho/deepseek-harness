# Agent Note: Container-backed per-Session execution

Status: implemented

[English](2026-10-31-container-sandbox-provider.md) | 中文

## Problem

宿主机文件隔离与 DSH 服务共享内核和文件系统；当 bubblewrap 或 Landlock 不可用时，它也无法启动。企业部署需要更强的执行边界，避免一个用户的模型代码读取其他用户的工作区或直接使用宿主网络。

## Decision

`@deepseek-ai/dsh-sandbox-container` 实现现有的 `ctx.sandbox` 提供方 seam。部署设置 `DSH_CONTAINER_SANDBOX_IMAGE` 后，base bundle 会停用宿主机提供方并启用容器提供方。每次受限调用都会创建一次性 Docker 或 Podman 容器，使用只读根文件系统、关闭网络、不保留 Linux capabilities，并设置 CPU、内存和进程上限；容器只为当前 Session 工作区提供一个可写挂载。配置的运行时根目录以只读方式挂载，使镜像能够执行 shipped Bash 和 Node 路径。提供方要求非 root 容器 uid:gid 和工作区根目录 allow-list；额外可写根目录会被拒绝，不会扩大挂载集合。

容器边界保护代码执行。Host 文件工具继续使用现有策略和 Remote 授权，MCP 与知识库请求继续由 Host 进程发起。容器按调用创建而非作为用户常驻进程，因此进程状态不会跨调用或用户共享，清理由容器运行时的 `--rm` 生命周期负责。

## Alternatives considered

**只保留宿主机 bwrap/Landlock。** 这种方式部署面最小，但不能解决没有可用后端的服务器，也没有提供独立的文件系统和网络命名空间。没有配置容器镜像时，现有提供方仍然是默认实现。

**把 Docker 命令放进 Cloud Agent 或 Bash 消费者。** 这样会让终端、PTC 和未来的 subprocess 消费者走不同执行路径，并重复策略、取消和失败处理。提供方 seam 让现有消费者都走同一条隔离路径。

**每个用户维护一个常驻容器。** 常驻容器可以保留 shell 状态，但需要第二个进程生命周期所有者、空闲回收、重启恢复和状态失效处理。当前先使用每次调用容器来提供隔离保证；持久交互状态仍属于终端提供方的独立职责。

## Consequences

部署必须提供兼容镜像、可用 Docker 或 Podman 运行时、非 root 工作区所有权和明确的工作区根目录 allow-list。镜像必须包含消费者需要的可执行文件路径。容器内代码不能直接调用 MCP 或知识库等网络能力；这些能力仍由 Host 侧提供。运行时和镜像成为新的运维依赖，但它们不可用时提供方会故障关闭，并保留现有 `SANDBOX_UNAVAILABLE` 处理。
