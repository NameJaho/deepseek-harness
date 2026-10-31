---
description: "Disposable Docker or Podman execution containers that mount one authorized Session workspace per confined call."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-container

English | [中文](README.zh.md)

## Summary

Run Bash, terminals, and Node-backed execution in a disposable Docker or Podman container. Each confined call mounts only the authorized Session workspace at its original absolute path; the container has no network, a read-only root filesystem, no Linux capabilities, and explicit CPU, memory, and process limits. The provider fails closed when the runtime or image is unavailable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Set `DSH_CONTAINER_SANDBOX_IMAGE` to enable the provider in the shipped base bundle. The launcher also sets an allow-list of workspace roots; set `DSH_CONTAINER_WORKSPACE_ROOTS` explicitly when the deployment stores workspaces outside `DSH_BASE/workspaces` or `DSH_HOME`. The image must provide Bash and its own Node runtime. `nodeExecutable` selects Node inside the image; it defaults to `/usr/local/bin/node` for the official Node image. Do not mount host system executable or library directories into the image.

```bash
DSH_CONTAINER_SANDBOX_IMAGE=node:24-bookworm
DSH_CONTAINER_RUNTIME=docker
DSH_CONTAINER_WORKSPACE_ROOTS=/srv/dsh/workspaces:/srv/dsh/data
DSH_CONTAINER_READONLY_ROOTS=/srv/dsh/app/packages:/srv/dsh/app/vendor:/srv/dsh/app/node_modules
```

The provider accepts `docker` or `podman`, mounts configured application roots read-only, and mounts the Session workspace at its original absolute path so PTC can use the same working directory on both sides. The launcher mounts only the repository’s `packages`, `vendor`, and `node_modules` directories, leaving root environment files outside the container. Every file under a configured read-only root is readable to session code; use roots containing runtime assets only. `read-only` adds `readonly` to the workspace `--mount` option; `workspace-write` uses the default read-write bind mount. Additional writable roots and mounts over image system executable or library directories are rejected. Mount paths cannot contain commas, double quotes, or line breaks.

| Field | Default | Meaning |
|---|---|---|
| `runtime` | `docker` | Container runtime executable. |
| `image` | required | Image used for every confined call. |
| `nodeExecutable` | `/usr/local/bin/node` | Node executable installed inside the image. |
| `workspaceRoots` | `[]` | Required allow-list for Session workspace roots. |
| `readOnlyRoots` | `[]` | Host roots mounted read-only for runtime files. |
| `memory` | `1g` | Container memory limit. |
| `cpus` | `2` | Container CPU quota. |
| `pidsLimit` | `256` | Maximum processes in one container. |
| `probeTimeoutMs` | `5000` | Runtime probe and container cleanup timeout in milliseconds. |
| `user` | DSH service uid:gid | Non-root numeric uid and gid inside the container; the workspace must be owned or writable by this identity. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider implements `ctx.sandbox`; existing Bash, terminal, and PTC consumers continue to resolve the shared Session policy. A host runner starts `runtime run --rm --init --network=none --read-only` with resource limits and the authorized mounts. The image uses its own executables and libraries. For PTC, a guest runner forwards Docker stdin/stdout to the worker’s private control pipe; program diagnostics go to stderr. Attachment closure kills the worker, and the host runner explicitly removes its named container after client exit. A new container is created for every confined call, so process state does not cross calls or users.

The provider checks the runtime before service readiness and checks the workspace against the configured physical-root allow-list before creating argv. Container runtime failures are reported as `SANDBOX_UNAVAILABLE`; unsupported extra mounts are reported as `SANDBOX_UNSUPPORTED_POLICY`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Process sandbox subsystem](../../../docs/subsystems/sandbox.md) — shared policy and enforcement facts.
- [Local sandbox provider](../sandbox-local/README.md) — host-local bwrap, Landlock, Seatbelt, and Windows ACL backends.
- [Sandbox service](../sandbox/README.md) — provider interface and escalation vocabulary.

<a id="model-experience"></a>
## Model Experience

### Container execution

#### What the model sees

The existing Bash, terminal, and `run_code` tools report the selected sandbox mode, enforcement level, denial, or unavailable-runtime failure. This provider adds no tool and no prompt section.

#### Token effect

Container status is carried by existing tool results and does not add a fixed prompt contribution.

#### KV Cache effect

The provider does not change tool schemas or prompt sections.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The provider supports POSIX hosts with Linux images; Windows host path translation is not implemented.
- The container shares the host kernel. Use gVisor or a microVM when a kernel-level boundary is required.
- Network access is disabled for the container. MCP and knowledge requests stay in the host process; approved PTC host tool bindings remain available to container programs.
- The image must provide Node and compatible command executables. Host-native modules mounted with application files may require a build for the image; the provider does not build or synchronize images.
- Filesystem tools still use their existing Host policy and do not run inside the container. The container protects code execution; the workspace allow-list and Remote authorization protect direct file operations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
