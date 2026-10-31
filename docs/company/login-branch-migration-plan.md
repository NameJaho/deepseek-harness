# Login branch feature migration and optimization handoff

English | [中文](login-branch-migration-plan.zh.md)

This document is the implementation handoff for a future AI agent. Keep the current WeCom login and member workspace isolation on `login`, and migrate the HMWORK brand, Cloud Agent MCP capabilities, and company knowledge retrieval from `master`. This is a proposed implementation plan; it does not claim that the features are already present on `login`.

## Contents

- [1. Branch state and strategy](#1-branch-state-and-strategy)
- [2. Scope](#2-scope)
- [3. Execution order](#3-execution-order)
- [Cloud Agent product flow and workspace fence](#cloud-agent-product-flow-and-workspace-fence)
- [4. Brand and local-build naming](#4-brand-and-local-build-naming)
- [5. MCP capability migration](#5-mcp-capability-migration)
- [6. Company knowledge migration](#6-company-knowledge-migration)
- [7. Logo migration](#7-logo-migration)
- [8. Tests and acceptance](#8-tests-and-acceptance)
- [9. Risks, rollback, and deliverables](#9-risks-rollback-and-deliverables)
- [10. AI execution checklist](#10-ai-execution-checklist)

## 1. Branch state and strategy

`master` and `login` diverged from one common history point. `master` contains `packages/company/cloud-agent`, `packages/company/cloud-agent-runtime`, `packages/company/knowledge`, and the company MCP directory. `login` contains the WeCom browser login and member workspace isolation changes. The working tree also has uncommitted WeCom files and local directories. Save those changes before migration; never use reset, clean, or a whole-branch overwrite.

Run these read-only checks and record the baseline:

```sh
git status --short --branch
git merge-base master login
git diff --stat login...master
git log --oneline --reverse master -- packages/company
```

Do not merge all of `master`. The full difference includes unrelated upstream changes. Migrate the relevant feature commits by file and dependency, then build and test after each stage. Do not replace the `login` lockfile, snapshots, or deployment scripts wholesale.

Keep brand, MCP adapter, knowledge, and Logo as separate commits so each can be reverted independently.

## 2. Scope

### Required

1. Replace the Hero text “探索未至之境” with `HMWORK`, and use one HMWORK naming policy for the local-build title, sidebar name, boot wordmark, and PWA metadata.
2. Migrate the Cloud Agent draft, release, session binding, and per-Agent capability selection framework.
3. Migrate MCP capability browsing, tool lists, schema inspection, status, loading, and recovery UI.
4. Migrate Host-owned company knowledge retrieval, source selection, release permission fingerprints, the `cloud_knowledge` tool, and its management page.
5. Use the supplied two-character image as the HMWORK Logo in the sidebar, Hero, boot page, browser icons, and install metadata.
6. Add a “Publish Agent” Command to every ordinary default-workspace conversation. It publishes the current conversation configuration as an online Agent visible in the Cloud Agent list.
7. Let user B use an Agent published by user A. Add a workspace named after that Agent in B’s UI and reuse it for later conversations with the same Agent.
8. Allow different mode presets when creating an Agent and when running the same Agent. Record the creation preset and run preset separately.
9. Allow a conversation to call an Agent deployed on Dify or another platform through the standard subagent route, with recorded input, state, output, and failure.
10. Add Agent information and Agent capabilities panes on an Agent workspace. Capabilities show only that Agent’s MCP, knowledge, and Agent-owned plugins, never global plugins.
11. Let the capabilities pane add or remove MCP and knowledge selections. Changes to a published Agent create a new draft or release and never mutate an old release.

### Explicitly excluded

1. Do not migrate the former Cloud Agent MCP directory implementation or mount `company-mcp-catalog`. A later external API will provide MCP data; the browser receives only redacted server, tool, and status data.
2. Do not collect MCP endpoints, bearer tokens, or credential references in the browser. The later API supplies MCP data; the client consumes only redacted server, tool, and status data.
3. Do not migrate HTML publication, the WeCom robot, Dify project execution, or Docker sandbox changes. If Cloud Agent temporarily depends on those packages, keep the package dependency only when required by the build and leave the unrelated services unmounted in the `login` profile.
4. Do not present knowledge retrieval as document import, index construction, or space management. Those operations remain owned by the external knowledge service.

### Responsibility split

| Layer | Owns | Must not own |
| --- | --- | --- |
| Web Client | Brand, source, tool, evidence, and state presentation | Endpoint, token, or private space ids |
| Host plugin | Configuration validation, provider calls, response filtering, lifecycle | Turning unknown failures into empty results |
| Cloud Agent | Draft and release capability selection and pre-step binding checks | Unauthorised model-selected tools or sources |
| External MCP API | Server and tool directory and tool execution | DSH internal storage formats |
| External knowledge API | Approved-space evidence retrieval | DSH document import and index management |

## 3. Execution order

### Stage 0: clean baseline

Save the uncommitted WeCom authentication files and local directories to a temporary branch or patch, including the current files under `packages/company/wecom-auth` and `.local/` or `.qoder/`. Use a separate worktree for the migration when possible. After every conflict resolution, inspect the WeCom diff again.

Read `docs/architecture.md`, `docs/defensive-patterns/README.md`, `packages/AGENTS.md`, and the README for every target package. Check the current `login` TypeScript references, package versions, and profile patch before choosing a `master` change.

### Stage 1: brand text and build variable

Set the default `DSH_CLIENT_TITLE` to `HMWORK` and route Hero, Sidebar, BootPage, HTML title, and manifest names through that value. Keep an environment override for deployments. Confirm that Web starts without Cloud Agent and no longer shows the old Hero text or “DSH Local Build”.

### Stage 2: Cloud Agent and external MCP seam

Migrate only the Cloud Agent base needed by MCP and knowledge, then migrate the capability sidebar, publication Command, and per-Agent selection code. Define the external `CompanyMcpProvider` and the Agent publication seam before wiring UI. Cloud Agent and the capability catalog must depend on these seams rather than on directory HTTP, the MCP SDK, or the credential store.

### Stage 3: knowledge Host, runtime, and page

Migrate the knowledge HTTP provider, validation, types, management controller and page, plus `cloud-agent-runtime` support for `knowledgeSources`, `cloud_knowledge`, and release binding checks. Do not migrate the knowledge MCP transport by default. Add a separate provider adapter only after the real external protocol is known.

### Stage 4: Logo and acceptance

Version the source image, generate UI and PWA sizes, connect the brand slots and static icons, then run build, type, unit, snapshot, and responsive checks.

## Cloud Agent product flow and workspace fence

### Publishing from an ordinary conversation

Register a “Publish Agent” Command in every ordinary default-workspace conversation. The Command may read only configuration already established by the Session: provider, model, mode preset, system instructions, approved MCP, knowledge, plugins, and permission summary. It must not persist tokens, endpoints, temporary paths, or browser-only state.

The Command creates or updates an Agent draft, asks the user to confirm its name, description, and visibility, then creates an immutable release. The release stores the source Session id, source event sequence, configuration summary, capability fingerprints, and creation time. The Cloud Agent page observes the new record through its catalog/follow stream. An unknown publication outcome keeps the draft and requires reconciliation; it must not create a second release by retrying blindly.

### Cross-user use and one Agent workspace

After user A publishes an Agent, user B can start it only through an authorized “Use Agent” action. The Host checks B’s owner scope and the Agent’s visibility policy, creates a usage Session, and binds it to the exact release id. The client creates one workspace navigation group for that Agent, named with the Agent name. The stable group key is derived from the Agent id, never from a Session id.

Using the same Agent again, or starting a new conversation from that Agent workspace, reuses the same workspace group. Only a new Session is created, and it remains bound to the selected release and run preset. Ordinary default-workspace conversations, Agent authoring, and external-agent subagent Sessions remain separate groups.

If an Agent is deleted, a release is withdrawn, access is revoked, or the Agent is disabled, the navigation group shows an explicit state. Existing Sessions recover from their persisted owner and release data; a directory refresh must not retarget them. A workspace-title change needs an explicit migration record and must not infer ownership from a matching title.

### Creation and run presets

Separate the Agent content and capability release from runtime presets. Creation may select a creation preset that determines the authoring Session tools, system prompt, permission, and model defaults. The source Session and publication audit retain this choice, but it cannot weaken release safety limits.

Running the same Agent may select another run preset. A run preset controls the current Session provider, model, reasoning, permission, and presentation only. It cannot add MCP, knowledge, plugins, or file authority outside the release. Each run records Agent id, release id, creation preset, run preset, and the effective configuration summary; resume and audit use the same fields.

### External Agents as subagents

Add a dedicated `ExternalAgentSubagentProvider` for Dify and other platforms. Do not represent an external Agent as a DSH MCP tool. Provider configuration stores platform, logical Agent id, version or environment, credential reference, timeout, input/output limits, and continuation policy. The browser sees logical name and status only.

When a parent conversation calls an external subagent, create the standard subagent descriptor/catalog record with external Agent, parent Session, input summary, start state, completion state, output reference, and error. Validate response size, encoding, and status. Timeout, unknown outcome, and partial response remain failures and are shown as recoverable failure in the parent Session. An external Agent does not inherit shell, MCP, knowledge, or global plugin authority unless the provider explicitly declares it and the release policy authorizes it.

### Agent information and capability panes

The Agent information pane shows the current Agent name, owner or public source, release version, creation and run presets, provider/model, state, invocation-chain link, latest output summary, and continuable Session. Long links and internal routes use a copy action with safe truncation; tokens, private endpoints, and complete prompts never appear.

The Agent capabilities pane reads the current Session’s retained release projection. It lists only the Agent’s MCP, knowledge, and Agent-owned code plugins; global plugins, deployment tools, and another Agent’s capabilities remain absent. An authoring Session may add, connect, or remove MCP and knowledge. A usage Session’s edit action first creates a controlled editor or new draft, and the user explicitly publishes the new release.

Add, remove, and publish operations use Agent id, draft revision, and release id for concurrency checks. Directory refresh never adds new MCP or knowledge automatically. Removing a capability does not affect an already-running old Session; it continues to use its fixed release.

## 4. Brand and local-build naming

`master` already uses `process.env.DSH_CLIENT_TITLE` in `EmptyHero.tsx`, `SidebarRoot.tsx`, and `boot-page.ts`. `login` still has direct fallback values in the Hero locale, local-build label, and `HARNESS` boot wordmark. Use this default map:

### Current code locations

### Recommended brand values

| Location | Default | Notes |
| --- | --- | --- |
| Hero | `HMWORK` | Replaces the old slogan |
| Sidebar local build | `HMWORK` | Keeps any version badge |
| BootPage wordmark | `HMWORK` | Replaces `HARNESS` |
| HTML title | `HMWORK`, with an optional local-build suffix in development | Never use the old DSH local-build title |
| PWA `name` and `short_name` | `HMWORK` | Uses one product name |
| Launcher | `DSH_CLIENT_TITLE=HMWORK` | Keeps deployment override support |

Keep the environment override and do not change package names, profile names, API paths, Session events, or persistence fields. If `ui-brand-official` occupies the brand slots, add an HMWORK occupant or replace it in the `login` profile. Do not change the shared `FishLogo` primitive.

### Implementation requirements

1. Use one brand configuration or environment value instead of separate strings in Hero, Sidebar, BootPage, `index.html`, and the manifest.
2. Pass `DSH_CLIENT_TITLE` through the existing build injection path; never read private server environment variables in the browser.
3. Change old Hero snapshot assertions to HMWORK while retaining the preview badge, accessible name, and responsive layout assertions.
4. Keep the change presentation-only: do not rename packages, profiles, Session events, API paths, or persisted fields.
5. If `ui-brand-official` occupies the generic slots, replace it in the login profile instead of changing the shared `FishLogo`.

## 5. MCP capability migration

Keep the user flow: the external API returns redacted server and tool summaries; an author selects them in the capability sidebar; the draft stores the selection; publication stores tool schema fingerprints; runtime registers only tools allowed by that release. Directory refresh must never silently change an old release.

### User capabilities to keep

Reuse the presentation and selection responsibilities of `capabilities.tsx`, `mcp-list.tsx`, `agent-mcp.ts`, `mcp-controller.ts`, and `mcp-page.tsx`, and the MCP fields of `CloudAgentDraft`, `CloudAgentRelease`, and `CloudAgentCapabilities`. Adapt them to the current `login` types instead of overwriting the files.

Define a Host `CompanyMcpProvider` with at least `catalog`, `follow`, `configure`, `discover`, `discoverTools`, `resolveTool`, and `describeTool`. Its response contains a stable server id, display name, description, status, tool names, descriptions, and parameter JSON Schema. Do not send endpoints, tokens, internal provider fields, or credentials to the browser. Use branded ids at cross-boundary types.

### Backend seam to replace

Remove the credential-reference input, directory URL, and directory-connect actions from the MCP page. Provide search, status, refresh, tool counts, and schema disclosure. Preserve the last successful data after load, discovery, save, or refresh failure and offer retry. Use a one-column touch-friendly layout on mobile and make long schemas wrap and copy safely.

Validate the server, tool, enabled state, and schema fingerprint before publication and again before execution. A changed tool requires rediscovery and a new release. Timeout, unknown state, connection failure, and invalid response remain failures; they must not become an empty tool list.

### Content to remove or omit

### MCP UI optimization

1. Provide search, active filters, and refresh at the top; search server names, descriptions, tool names, and tool descriptions.
2. Group servers into cards with name, purpose, state, tool count, and update time. Express available, connecting, failed, and maintenance in text and color.
3. Keep tool details collapsed by default; show a parameter table before the full JSON Schema and provide a copy action.
4. Show selected server and tool counts in the draft editor and fixed selections in a read-only release view.
5. Disable duplicate submissions, retain the last successful snapshot after failure, and provide retry.
6. Keep a one-column touch layout on mobile and wrap long schema content without horizontal overflow.

### MCP runtime safety

## 6. Company knowledge migration

Host configuration owns the logical source id, display metadata, external URL, private headers, allowed spaces, topK, score threshold, timeout, and response byte limit. The browser and model see only logical source metadata and validated evidence.

### Capability migrated from `master`

### Recommended interface and security

The HTTP request may keep `query`, `space_ids`, `top_k`, `mode: hybrid`, and `rerank: true`; the response must validate `results`, `total_hits`, chunk id, document id, title, breadcrumb, complete content, score, and space id. Match the actual external service and keep protocol conversion inside a provider file.

Read the complete bounded response, reject evidence from another space, deduplicate content, filter low scores, and cap topK. An empty result means no reliable evidence. Network, HTTP, timeout, JSON, and authorization failures are structured failures.

The current `master` package also supports an MCP transport. Do not copy that transport into this migration because MCP data will come from another interface. If a later external endpoint is Streamable HTTP MCP, add a separate `KnowledgeProvider` adapter that returns the same evidence type.

Replace the simple source select and result list with three sections: source cards, a search panel, and evidence cards. Source cards show purpose and state but not URLs, space ids, or headers. The search panel has character count, submitting, cancel, and retry states. Evidence cards show title, breadcrumb, score, complete text, and copy. Empty, unconfigured, loading, failed, and timed-out states use different messages, and failures retain the last successful result. Localize all copy and make long evidence wrap or collapse on mobile.

The Agent capability editor shows selected knowledge sources; a release shows them read-only. `cloud_knowledge` accepts only a logical source id and a natural-language question. A changed space grant blocks the old release and requires republishing. A release without a selected source never receives the tool automatically.

### Knowledge experience in Cloud Agent

### Knowledge page optimization

1. Show source cards with name, purpose, availability, and recent status; hide URLs, space ids, and headers.
2. Provide question input, character count, submitting state, cancel, and retry; disable submit for empty, overlong, or active requests.
3. Show evidence cards with document title, section, score, complete text, and copy action.
4. Distinguish empty, unconfigured, loading, failed, and timed-out states; retain the last successful result after failure.
5. Collapse or paginate large result sets and wrap long evidence on mobile.
6. Explain that the page supports retrieval only; do not add an upload or index button that cannot work.
7. Keep all copy in English and Chinese locale dictionaries.

## 7. Logo migration

Save the supplied image as a versioned source such as `apps/web/public/brand/hmwork-source.png`; never reference the temporary attachment path. Generate 24, 34, 192, 512, maskable 512, and Apple touch assets with controlled crop, transparency, safe area, and light/dark readability.

### Asset processing

Prefer the existing `sidebar.brand.mark` and `conversation.hero.brand.mark` slots. Add an HMWORK brand client plugin and replace the official occupant in the `login` profile. BootPage, favicons, manifest, and desktop shortcut metadata should reference generated static assets. Keep the existing aria label when the image is the only visible brand name.

### Integration locations

## 8. Tests and acceptance

Brand tests cover Hero, Sidebar, BootPage, title, manifest, light theme, dark theme, narrow layout, and high zoom. MCP fixtures cover malformed directory data, duplicate ids, invalid schemas, connection failure, timeout, stale-data retention, and disposal. Client tests cover search, state, schema, empty, failure, retry, and mobile layout. Snapshots must prove that credentials and endpoints never reach model input.

### Brand acceptance

- Test Hero, Sidebar, BootPage, title, manifest, light theme, dark theme, narrow layout, and high zoom.
- Check the Logo in expanded and collapsed sidebar states, with and without a build version.
- Check the BootPage wordmark and PWA name, short name, and icon references.
- Preserve preview badge and accessible labels while changing the brand text.
- Inspect the Logo in real browsers and verify that it does not overflow or distort.

### Cloud Agent product acceptance

- An ordinary default-workspace conversation discovers “Publish Agent”; publication confirms name, description, and visibility, then the Cloud Agent list shows the exact release.
- After user A publishes, user B can use the Agent; B’s navigation creates one workspace keyed by Agent id, and repeated new conversations never create a second workspace.
- Creation and run preset combinations appear in audit and Session projections; a run preset cannot bypass release MCP, knowledge, plugin, or file authority.
- A Dify or other external subagent records descriptor/catalog, input summary, in-progress state, output, and error; timeout and unknown outcomes never appear as success.
- Agent information shows owner, release, preset, provider/model, invocation chain, state, and output summary. Agent capabilities shows only that Agent’s MCP, knowledge, and owned plugins.
- An authoring Session can add or remove capabilities; a usage Session first creates a controlled editor draft. Directory refresh and capability removal never change old releases or running Sessions.

### MCP acceptance

- Fixture malformed directory data, duplicate ids, invalid schemas, connection failure, timeout, stale-data retention, and disposal.
- Test draft selection, publication binding, schema fingerprints, changed-tool rejection, and old-release stability.
- Test search, state labels, schema disclosure, copy, empty, failure, retry, and mobile width.
- Snapshot that only release-selected tools enter the prompt and schema and that credentials and endpoints never enter logs.

Knowledge fixtures cover cross-space evidence, duplicates, low scores, empty results, byte limits, invalid JSON, HTTP errors, and timeout. Cloud Agent tests cover source selection, release fingerprint changes, and the absence of `cloud_knowledge` when no source is selected. Client tests cover the three-section page and mobile layout. A keyless snapshot covers the tool schema, system prompt, and evidence result; a fixture does not prove production connectivity.

### Knowledge acceptance

- Fixture cross-space results, duplicate content, low scores, empty results, response limits, invalid JSON, HTTP errors, timeout, and disposal.
- Test source selection in drafts and releases, changed fingerprints, and no `cloud_knowledge` without a selection.
- Test source loading, searching, empty results, retained failure state, evidence folding, and mobile layout.
- Record a keyless snapshot for the tool schema, source prompt, and complete evidence result; verify production separately.

### Required repository checks

Run the smallest current checks that cover the change, at least:

```sh
pnpm install --frozen-lockfile
pnpm run build:artifacts
pnpm run build:check
pnpm run test:docs
pnpm run test -- packages/company/knowledge packages/company/cloud-agent packages/client/ui-conversation packages/client/ui-sidebar packages/client/web
pnpm run lint
git diff --check
```

Add the migrated packages to the workspace, package manifests, TypeScript references, and lockfile before building if they are absent on `login`. Do not skip failed tests. Update the keyless snapshots for every product-visible change.

## 9. Risks, rollback, and deliverables

Cloud Agent may depend on newer Session, Remote, storage, or slot types than `login` has. Adapt to the current types instead of pulling unrelated upstream changes. Keep only one actual MCP execution provider. Validate all knowledge evidence in the Host. Generate and inspect Logo resources in a real browser and PWA manifest. Recheck the WeCom diff after every conflict.

### Main risks

1. Cloud Agent may require newer Session, Remote, storage, or slot types than `login`; adapt to current types without unrelated upstream changes.
2. Keeping two MCP providers can cause duplicate registration, inconsistent credentials, and invalid release fingerprints; keep one execution provider.
3. Knowledge responses can contain unauthorized spaces or private fields; validate all evidence in the Host.
4. The Logo source can contain large white margins or excessive dimensions; generate and inspect all sizes.
5. Conflict resolution can overwrite uncommitted WeCom work; recheck its diff after every conflict.

### Rollback

### Deliverables

1. Staged `login` commits and test records for each phase.
2. External MCP request, response, error, and state field documentation, including fields excluded from the browser and Session log.
3. External knowledge request, response, authorization, and error documentation.
4. HMWORK source image, generation script, generated sizes, and icon review captures.
5. Updated locales, MCP/knowledge/brand snapshots, and build and test output.

Make brand, MCP provider, knowledge, and Logo separate commits. A rollback of MCP must leave Cloud Agent and knowledge independent; a rollback of knowledge must remove its profile mount and runtime tool without breaking releases that have no knowledge binding; a Logo rollback restores the old occupant and icons without deleting the source image.

Deliver the staged commits, external MCP request/response/error documentation, external knowledge protocol documentation, Logo source and generated assets, updated locales and snapshots, and the build and test output.

## 10. AI execution checklist

- [ ] Save the current uncommitted WeCom and local files.
- [ ] Record branch refs and merge-base; do not merge the whole branch.
- [ ] Apply HMWORK to Hero, title, manifest, and launcher defaults.
- [ ] Connect the Logo through brand slots; do not change shared `FishLogo`.
- [ ] Register “Publish Agent” in default-workspace conversations and persist an auditable release.
- [ ] Implement cross-user use, one Agent workspace, separate creation/run presets, and the external subagent provider.
- [ ] Complete Agent information and Agent capabilities panes, hide global plugins, and protect old releases.
- [ ] Replace the MCP directory with an external `CompanyMcpProvider`; do not mount `company-mcp-catalog`.
- [ ] Remove or isolate directory refresh, MCP session initialization, mock directory, and credential-reference UI.
- [ ] Preserve Agent selection, release binding, schema fingerprints, Session records, and failure recovery.
- [ ] Migrate the knowledge HTTP provider, source fingerprints, and `cloud_knowledge`; leave knowledge MCP transport out by default.
- [ ] Implement the knowledge source, search, evidence, error, and mobile UI states.
- [ ] Generate and verify Logo, favicon, PWA, and manifest assets.
- [ ] Update English and Chinese locales, tests, e2e cases, snapshots, and documentation.
- [ ] Run `build:artifacts` before `build:check`, then run `git diff --check`.
- [ ] Confirm external interface fields with real samples before integration; do not guess a protocol.

## Dev Note

Even if the MCP and knowledge services later share one enterprise gateway, keep two providers. The MCP provider owns tool discovery and execution; the knowledge provider owns evidence retrieval and space validation. Shared HTTP, authentication, and timeout helpers are acceptable, but one provider must not read another provider's private configuration.
