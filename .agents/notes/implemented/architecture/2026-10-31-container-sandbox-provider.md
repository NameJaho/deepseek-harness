# Agent Note: Container-backed per-Session execution

Status: implemented

English | [中文](2026-10-31-container-sandbox-provider.zh.md)

## Problem

Host-local file confinement shares the DSH service's kernel and filesystem, and it cannot start when bubblewrap or Landlock is unavailable. Company deployments need a stronger execution boundary so one user's model-written code cannot inspect another user's workspace or use the host network directly.

## Decision

`@deepseek-ai/dsh-sandbox-container` implements the existing `ctx.sandbox` provider seam. When a deployment sets `DSH_CONTAINER_SANDBOX_IMAGE`, the base bundle disables the host-local provider and mounts the container provider instead. Each confined call creates a disposable Docker or Podman container with a read-only root filesystem, no network, no Linux capabilities, explicit CPU, memory, and process limits, and one writable mount for the calling Session workspace. Configured runtime roots are mounted read-only so the image can execute the shipped Bash and Node paths. The provider requires a non-root container uid:gid and a configured workspace-root allow-list; it rejects extra writable roots instead of widening the mount set.

The container boundary protects code execution. Host filesystem tools keep their existing policy and Remote authorization, while MCP and knowledge requests remain in the Host process. The container is per call rather than a persistent user daemon, so process state cannot cross calls or users and cleanup is owned by the container runtime's `--rm` lifecycle.

## Alternatives considered

**Keep host-local bwrap/Landlock as the only implementation.** This preserves the smallest deployment surface, but it does not solve hosts without a usable backend and does not provide a separate filesystem and network namespace. The existing provider remains the default when no container image is configured.

**Add Docker commands inside Cloud Agent or the Bash consumer.** This would leave terminals, PTC, and future subprocess consumers on a different execution path and would duplicate policy, cancellation, and failure handling. The provider seam keeps every existing consumer on one confinement path.

**Use a persistent container per user.** A long-lived container would preserve shell state, but it would require a second process-lifecycle owner, idle cleanup, restart recovery, and state invalidation. Per-call containers provide the isolation guarantee now; persistent interactive state remains the terminal provider's separate concern.

## Consequences

The deployment must provide a compatible image, a working Docker or Podman runtime, non-root workspace ownership, and an explicit workspace-root allow-list. The image must contain executable paths expected by the selected consumers. Network-dependent code inside a container cannot call MCP or knowledge services directly; those capabilities remain host-side. The runtime and image become additional operational dependencies, but the container provider fails closed when they are unavailable and preserves the existing `SANDBOX_UNAVAILABLE` handling.
