---
description: "Owner-scoped Agent drafts, immutable MCP, knowledge-source and skill releases, and private usage conversations."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-cloud-agent

English | [中文](README.zh.md)

## Summary

An opt-in Host and Web bundle for saving reusable conversation requirements and publishing exact MCP, direct knowledge-source and skill selections. It depends on the MCP provider and optionally the Host-owned direct knowledge service. It contains no MCP directory implementation, credentials editor, shell execution, Docker, HTML publishing or external Agent execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Ownership and execution](#ownership-and-execution)
- [Persistence and lifecycle](#persistence-and-lifecycle)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Apply [cordis.patch.yml](cordis.patch.yml) to a profile that supplies the injected Host services and an MCP provider. The patch mounts only the catalog service and sets an absolute private `workspaceRoot`; it does not install or configure a provider. [Config](src/config.ts) owns publication, skill, attachment-page and report bounds. `capabilityPreset` identifies the deployment's skill catalog scope; it is separate from creation and run presets.

In an owned, selectable/default conversation with `workspace-write` or `danger-full-access`, use `/create-agent [requirements]` or `/publish-agent`. Without a saved draft, the command queues extraction from the confirmed conversation; it does not publish. Review the saved name, description and revision, then explicitly run `/publish-agent confirm <revision> <public|private>`. Confirmation calls publication directly, without another model turn. An exact replay returns the existing release; a stale or conflicting confirmation fails without another release. After an unknown outcome, inspect the catalog before retrying.

New editors keep a profile default of `danger-full-access`; otherwise they request `workspace-write`. On a host without a usable sandbox, a controlled test deployment can explicitly set `DSH_PERMISSION_MODE=danger-full-access` in the launcher's `startup.env`; this removes file restrictions and approval prompts. Existing Sessions retain their recorded permissions, so open a new editor after changing the default.

Authors may also open a private editor with `startAuthoring`, save through `cloud_agent`, or preview an exact draft revision in a separate private Session. Saving snapshots MCP tool signatures, direct knowledge-source permission fingerprints and skill instructions/resources. Selecting a server expands its tools at save time. Knowledge sources are configured Host-side from the direct `POST /knowledge_search_api/retrieve` service and do not require an MCP server. Publication uses those saved snapshots, verifies current permissions and signatures, records visibility and source Session id/event sequence/preset/permission, and hashes the effective definition and captured capabilities.

## Ownership and execution

The catalog exposes owned drafts, current public-or-owned releases and only the caller's conversations. Public entries omit another owner's source Session audit. New usage Sessions belong to the user starting them, not the publisher, and pin an exact release id. Existing Sessions retain their original owner and release after withdrawal, visibility changes, new publication or deletion. Usage entries report `available`, `updated`, `disabled`, `withdrawn`, `access-lost` or `deleted`; these states never redirect an existing Session.

`creationPreset` and `runPreset` must be selectable. Creation mounts its preset in the editor. A usage Session mounts only its retained release preset: `runPreset` is validated and recorded, not mounted, so it cannot add tools or permissions. Optional provider/model overrides are validated. Binding audit records creation/run presets and an effective digest including the release, run preset, actual model and enforced `read-only` permission. The runtime supplies only approved MCP tools, direct knowledge retrieval, pinned skills, downloadable text reports and conversation-owned file reads; see [runtime](../cloud-agent-runtime/README.md).

The optional WeCom resource provider grants the package's Remote actions and exactly `/create-agent` and `/publish-agent` in member default Workspaces. It invalidates access snapshots after committed catalog changes. Session owners are resolved from durable bindings or the member default Workspace, never from publication ownership. Creation-provider routing handles current retained releases; fork placement allocates private files while retained binding events preserve ownership.

## Persistence and lifecycle

[Types](src/types.ts) and [storage](src/storage.ts) define the durable Agent records and conversations. `cloud-agent/binding` supplies recoverable Session ownership and preset audit through `companyCloudAgentBinding`; domain records remain the catalog's source of truth. Recovery refuses retained Agent Sessions with missing ownership evidence. Release definitions are immutable; updates advance the draft revision and deletion keeps a tombstone with retained releases.

The service serializes mutations, registers retained presets before committing publication, and removes tentative registrations on failure. Failed Session preparation unwinds its handle, Workspace registration and private files; rollback failures are aggregated. Unload waits for tracked MCP calls and removes owned presets, commands and permission guards. MCP failures remain failures, not empty success results.

## Model Experience

### Draft authoring tool

#### What the model sees

The `cloud_agent` schema and descriptions in [authoring.ts](src/authoring.ts), with catalog, discover, save, preview and clone actions, but no publish action. Catalog results contain permitted draft summaries, model choices and capability names; save returns the complete draft, revision and confirmation command. Secrets and execution configuration are not accepted fields.

#### Token effect

The tool schema adds a fixed prompt contribution where visible. Catalog/discovery results vary with permitted choices; saved instructions are bounded by the draft parser. Tool calls and results enter ordinary Session history. Queued command extraction adds one logged user message rather than copying the whole conversation.

#### KV Cache effect

The schema is stable while registrations remain unchanged; catalog and tool results append history. Changing a preset or visible tools can replace prompt tokens and invalidate an otherwise reusable prefix. Commands that only review or publish add no model request themselves.

### Retained authoring instructions

#### What the model sees

Only the retained `cloud-agent-authoring` preset supplies this literal guidance; ordinary selectable editors retain their own preset prompt.

##### Verbatim authoring guidance

```markdown
Help the user refine reusable Agent requirements. Use cloud_agent catalog and save to preserve confirmed instructions and selected MCP tools, knowledge sources and skills. Exclude credentials and one-off results. Publication requires the user to confirm the saved revision and visibility with /publish-agent.
```

#### Token effect

A fixed contribution appears only when that retained authoring preset is composed. Usage instructions and skill/report/file results are owned by the linked runtime, not this guidance.

#### KV Cache effect

The repeated guidance is prefix-stable within that preset; switching to another preset changes the prompt. Provider cache availability and eviction remain outside this package.

## Known Limitations and Deferred Work

- Run preset behavior beyond validation and audit is not applied; reasoning and presentation changes require a separate capability-safe composition design.
- External Agent subagents, executable plugins and shell access are outside this bundle. Knowledge retrieval requires at least one approved direct source in `DSH_COMPANY_KNOWLEDGE_SOURCES`; it is not provided by MCP.
- Publication cannot be inferred from a queued extraction request. Users must wait for a saved revision and explicitly confirm it; an uncertain result requires catalog inspection.
- Deployment/profile wiring, generated catalogs, persistence acknowledgements and a Loader-driven recorded Session are integration responsibilities; focused Host fixtures do not establish production connectivity.

### Dev Note

Remote resource readers must identify the request's source or editor Session; package grants do not replace the mutation's owner and revision checks. New creation or fork routes must retain those checks and the release runtime policies.
