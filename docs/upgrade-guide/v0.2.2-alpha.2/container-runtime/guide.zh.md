---
kind: upgrade-guide
description: "容器沙箱拒绝挂载宿主系统运行时目录，并保留工作区原始路径。"
---

# 容器运行时挂载

[English](guide.md) | 中文

## 变更

容器执行使用镜像中的 Node 可执行文件，由 `nodeExecutable` 选择（默认 `/usr/local/bin/node`）。提供方拒绝会覆盖镜像系统可执行文件或库的 `readOnlyRoots`。包含逗号、双引号或换行的挂载路径也会被拒绝。工作区挂载到原始绝对路径，而不再使用 `/workspace`。显式挂载宿主 Node 或命令使用 `/workspace` 的部署需要更新配置。

## 迁移

1. 从 `startup.env` 和启动环境文件的 `DSH_CONTAINER_READONLY_ROOTS` 中移除宿主 Node 和系统目录，例如 `/usr/bin`、`/usr/local/bin` 和 `/lib`。还应移除显式仓库根目录挂载，避免向会话代码暴露根目录中的环境文件。启动器默认挂载仓库的 `packages`、`vendor` 和 `node_modules` 目录以提供 bootstrap 文件。
2. 如果镜像将 Node 安装在其他位置，将 `DSH_CONTAINER_NODE_EXECUTABLE` 设置为镜像内路径。不要挂载宿主 Node 目录来提供它。
3. 将引用 `/workspace` 的命令更新为使用 Session 的实际工作目录。
4. 使用 `pnpm run build:artifacts --serial` 重新构建，重启部署，然后在 `run_code` 中重试 `return 1 + 1` 和一次 Host 工具绑定调用。确认两者均能完成，且没有 libc 或控制管道错误。
