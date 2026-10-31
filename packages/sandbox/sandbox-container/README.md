---
description: "Disposable Docker or Podman execution containers that mount one authorized Session workspace per confined call."
kind: "package-reference"
---

# @deepseek-ai/dsh-sandbox-container

English | [中文](README.zh.md)

## Summary

Run Bash, terminals, and Node-backed execution in a disposable Docker or Podman container. Each confined call mounts only the authorized Session workspace at `/workspace`; the container has no network, a read-only root filesystem, no Linux capabilities, and explicit CPU, memory, and process limits. The provider fails closed when the runtime or image is unavailable.

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

Set `DSH_CONTAINER_SANDBOX_IMAGE` to enable the provider in the shipped base bundle. The launcher also sets an allow-list of workspace roots; set `DSH_CONTAINER_WORKSPACE_ROOTS` explicitly when the deployment stores workspaces outside `DSH_BASE/workspaces` or `DSH_HOME`. The image must contain the executable paths used by the selected consumers, including Bash and the Node runtime used by PTC.

```bash
DSH_CONTAINER_SANDBOX_IMAGE=node:24-bookworm
DSH_CONTAINER_RUNTIME=docker
DSH_CONTAINER_WORKSPACE_ROOTS=/srv/dsh/workspaces:/srv/dsh/data
DSH_CONTAINER_READONLY_ROOTS=/srv/dsh/app
```

The provider accepts `docker` or `podman`, mounts configured read-only runtime roots at their original paths, and mounts the Session workspace as `/workspace`. The test launcher adds the host Node executable directory to the read-only roots because PTC resolves its executable before the sandbox wraps the call. `read-only` adds `readonly` to the workspace `--mount` option; `workspace-write` uses the default read-write bind mount. Additional writable roots are rejected because the container must have one explicit workspace mount per call.

| Field | Default | Meaning |
|---|---|---|
| `runtime` | `docker` | Container runtime executable. |
| `image` | required | Image used for every confined call. |
| `workspaceRoots` | `[]` | Required allow-list for Session workspace roots. |
| `readOnlyRoots` | `[]` | Host roots mounted read-only for runtime files. |
| `memory` | `1g` | Container memory limit. |
| `cpus` | `2` | Container CPU quota. |
| `pidsLimit` | `256` | Maximum processes in one container. |
| `user` | DSH service uid:gid | Non-root numeric uid and gid inside the container; the workspace must be owned or writable by this identity. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider implements `ctx.sandbox`; existing Bash, terminal, and PTC consumers continue to resolve the shared Session policy. It emits `runtime run --rm --init --network=none --read-only` followed by the resource limits, capability drop, read-only runtime mounts, the one Session workspace mount, the image, and the original argv. The Session id is a container label for operator inspection. A new container is created for every confined call, so process state does not cross calls or users.

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

- The container shares the host kernel. Use gVisor or a microVM when a kernel-level boundary is required.
- Network access is disabled for the container. MCP and knowledge requests stay in the host process and are not available to code running inside the container.
- The image must provide compatible executable paths and runtime libraries; the provider does not build or synchronize images.
- Filesystem tools still use their existing Host policy and do not run inside the container. The container protects code execution; the workspace allow-list and Remote authorization protect direct file operations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
