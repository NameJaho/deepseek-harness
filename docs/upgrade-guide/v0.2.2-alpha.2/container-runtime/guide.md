---
kind: upgrade-guide
description: "Container sandboxes reject host system runtime mounts and retain the original workspace path."
---

# Container runtime mounts

English | [中文](guide.zh.md)

## Change

Container execution uses the image’s Node executable, selected by `nodeExecutable` (default `/usr/local/bin/node`). The provider rejects `readOnlyRoots` that replace image system executables or libraries. Mount paths containing commas, double quotes, or line breaks are also rejected. Workspaces are mounted at their original absolute path instead of `/workspace`. Deployments with explicit host Node mounts or commands using `/workspace` must update their configuration.

## Migration

1. Remove host Node and system directories such as `/usr/bin`, `/usr/local/bin`, and `/lib` from `DSH_CONTAINER_READONLY_ROOTS` in `startup.env` and the launch environment file. Remove an explicit repository-root mount as well, since it exposes root environment files to session code. The launcher defaults to the repository’s `packages`, `vendor`, and `node_modules` directories for bootstrap files.
2. If the image installs Node elsewhere, set `DSH_CONTAINER_NODE_EXECUTABLE` to its image path. Do not mount the host Node directory to supply it.
3. Update commands that refer to `/workspace` to use the Session’s actual working directory.
4. Rebuild with `pnpm run build:artifacts --serial`, restart the deployment, and retry `return 1 + 1` followed by a host tool binding in `run_code`. Verify both complete without a libc or control-channel error.
