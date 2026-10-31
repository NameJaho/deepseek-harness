---
description: "Literal release prompts and Agent-owned MCP, skill, report and attachment policies."
kind: "package-reference"
---

# @deepseek-ai/dsh-company-cloud-agent-runtime

English | [中文](README.zh.md)

## Summary

A scoped preset plugin consumed by the [Cloud Agent Host](../cloud-agent/README.md). The Host compiles trusted configuration from a saved release; this plugin is not an independent execution provider and does not accept connection settings, credentials or executable YAML.

## Table of Contents

- [Configuration and enforcement](#configuration-and-enforcement)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Configuration and enforcement

[Config](src/index.ts) requires literal `instructions` and `releaseId`, with optional exact `mcpTools`, direct `knowledgeSources`, pinned `skills` and `mode` (`release` by default). Skill resources contain exact relative paths and base64 bytes. The Host owns durable validation, snapshot bounds and private materialization; runtime callers must supply Host-validated release data.

Release mode replaces the scoped persona without interpolation and suppresses deployment runtime context. At Agent creation it resolves approved MCP wrappers through the Host, hides global tools and installs an execution guard. It adds `cloud_knowledge` when direct sources were selected, `cloud_report` for bounded downloadable UTF-8 reports, and `cloud_skill` only when skills were selected. `cloud_knowledge` calls the Host-owned direct retrieve service and keeps source spaces and endpoints out of the release. `cloud_file` is registered only when this conversation has recorded or queued uploads, or later receives a file; it accepts recorded attachment ids, not filesystem paths. Report and file execution check the receiving Agent identity. Before each model step, the Host revalidates the MCP signatures; failure stops the dependent step.

Authoring mode exposes only `cloud_agent`; it cannot execute MCP tools, reports or attachment reads. Its literal prompt may contain pinned skill instructions. Tool restrictions and execution guards are owned by the Agent, so unloading the runtime does not expose global tools while that Agent remains alive. Agent teardown removes the policies. The runtime does not change the deployment's tool presentation mode.

## Model Experience

### Literal persona and skill list

#### What the model sees

The exact saved instructions. Release mode adds selected skill names and descriptions after the literal heading `Available skills (load instructions with cloud_skill before using them):`; skill bodies are returned only on demand. Authoring mode instead includes each selected body under `# Skill: {name}`. Templates in instructions remain literal text. Suppressed runtime context does not replace these instructions with Host filesystem or deployment details.

#### Token effect

Persona size follows the validated saved instructions and selected skills. A release lists descriptions rather than inserting all skill bodies; loading a skill appends its complete pinned instructions or resource bytes as a tool result. Resource and instruction sizes are bounded during Host snapshotting.

#### KV Cache effect

Instructions and selected capabilities are stable within one immutable release. Switching release or authoring mode changes the prompt prefix. On-demand skill results append history; registering `cloud_file` after an upload changes the visible schema list and can invalidate prefix reuse.

### Scoped tools and results

#### What the model sees

Only the approved MCP schemas, the applicable `cloud_knowledge`, `cloud_skill`, `cloud_report` and `cloud_file` definitions in [index.ts](src/index.ts). MCP descriptions and parameters come from the signature-checked provider. Skill results carry pinned instructions or UTF-8/base64 resource data; file results carry conversation-owned references or verified pages; report results carry downloadable report metadata. No global shell or arbitrary file access is exposed.

#### Token effect

Schemas contribute fixed text per selected tool. Provider results vary; report bytes and text-page sizes are bounded by the Host. Skill and file calls append their results to normal Session history. Reports preserve complete text in persisted tool-result metadata and use a short rendered result.

#### KV Cache effect

A fixed capability set preserves a repeated schema prefix. Upload-triggered file registration changes that prefix; tool results append history. Provider cache allocation and eviction are independent of these policies.

## Known Limitations and Deferred Work

- No shell, Docker, executable plugins or external Agent execution is provided. Knowledge retrieval requires an approved direct source and the Host service.
- Resource reads return pinned text or base64; they do not grant filesystem access. Attachments support only verified UTF-8 pages, not binary interpretation.
- This plugin trusts Host-compiled release configuration. Direct deployment configuration must not bypass the Host's durable parser or release authorization.

### Dev Note

`tools.restrict` accepts inherited global tool names, not tools registered in this Agent's scope. Keep scoped registration and executor authorization together when adding a release capability; schema visibility alone does not authorize execution.
