---
description: "Optional Host-only external agent delegation through the subagent provider seam and a private Dify blocking adapter."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-external-agent-subagent

English | [中文](README.zh.md)

## Summary

`ExternalAgentSubagentProvider` registers one `ctx.subagents` backend per configured logical agent. It delegates only a standalone text task and explicitly configured input variables. The external app owns its own model, tools, knowledge access and permissions; no parent transcript, shell, MCP, knowledge permissions, files, environment or credentials are inherited. This is neither an MCP server nor Dify project/workflow execution. `DifyAdapter` implements the replaceable `ExternalAgentAdapter` interface; the supported deployment platform is currently `dify`.

## Table of Contents

- [Private configuration](#private-configuration)
- [Calls, records and continuation](#calls-records-and-continuation)
- [Failure handling](#failure-handling)
- [Integration and verification](#integration-and-verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="private-configuration"></a>
## Private configuration

The service injects `subagents`, `credentials` and `agents`. Every agent field is required; `agents: []` registers nothing. The optional [bundle patch](cordis.patch.yml) is not enabled globally and leaves its delegation tool disabled. An explicit Host overlay supplies private configuration and mounts the normal delegation tool in the desired scope.

```yaml
- name: '@deepseek-ai/dsh-company-external-agent-subagent'
  config:
    agents:
      - platform: dify
        id: research
        name: Research agent
        version: release-1
        environment: production
        providerName: external-research
        endpoint: https://dify.example.com/v1/chat-messages
        credentialRef: DIFY_RESEARCH_KEY
        inputs: { language: zh }
        timeoutMs: 60000
        maxInputBytes: 65536
        maxOutputBytes: 262144
        maxRetainedRuns: 1000
        allowContinuation: false
- name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: external-research
    toolName: subagent_external_research
    maxDepth: provider-managed
```

| Field | Meaning |
|---|---|
| `platform` | `dify`; unsupported platforms fail at load. |
| `id`, `providerName` | Unique logical id and provider registry name; lowercase identifiers starting with a letter. |
| `name`, `version`, `environment` | Nonblank deployment descriptors, each at most 128 UTF-16 code units; these do not select an app remotely. |
| `endpoint` | Complete `/chat-messages` POST URL; HTTPS, or loopback HTTP for fixtures. Embedded credentials, query strings and fragments are rejected. |
| `credentialRef` | Credential-service reference, never a token; resolved once per call without caching. |
| `inputs` | Explicit lossless JSON object matching the app's declared input variables; no variables are guessed. |
| `timeoutMs` | Whole-call deadline including credential resolution and body consumption; positive integer up to 2147483647 ms. |
| `maxInputBytes` | Complete UTF-8 JSON request-body limit, including protocol fields and configured inputs. |
| `maxOutputBytes` | Limit on decompressed response bytes and the complete serialized success result. Failure diagnostics remain within the seam's separate 4096-byte cap. |
| `maxRetainedRuns` | Positive per-agent descriptor capacity; new admission fails rather than discarding retained records. |
| `allowContinuation` | Permits explicit Host-only continuation of the latest successful owned child. |

Numeric limits are positive safe integers. Invalid deployment configuration fails before provider registration. A provider-name collision is rejected by the standard registry. `agentOptions`, `agentPreset`, output schemas and local depth caps are unsupported, both at the seam and at the provider executor.

<a id="calls-records-and-continuation"></a>
## Calls, records and continuation

The adapter uses the [documented Dify chat API](https://docs.dify.ai/api-reference/chat/send-chat-message): blocking `POST chat-messages` with only `inputs`, `query`, `response_mode: blocking`, an opaque parent/agent-derived `user`, and optional `conversation_id`. It accepts only HTTP 200 JSON with UTF-8 encoding, a complete `event: message` response in `chat` or `advanced-chat` mode, and valid nonempty `answer`, `conversation_id` and `message_id`. The event `id` is not substituted for `message_id`. Metadata is ignored; streams, partial answers, invalid identifiers and changed continuation conversation ids fail. Redirects and automatic retries are disabled.

The Host service exposes `catalog()`, `startActivation(agentId, spec, continuationOf?)` and `describeRun(agentId, parent, childId)`. `catalog()` contains only logical descriptors and configured/disposed status, not a health or credential check. `describeRun()` retains the parent-child association, logical deployment, timestamps, input/output byte counts and SHA-256 references, continuation ancestry and structured failure. It never exposes the endpoint, credential reference, bearer value, remote identifiers or answer content. These methods register no browser Remote or execution endpoint; a separate authorized UI projection may use the safe `./types` descriptors only.

Use managed `startActivation` with `delivery: parent` for model-visible work. The existing subagent manager writes the standard external parent catalog entry and delivers the result through its logged `subagent-settled` notice. `delivery: caller` returns a private result without a parent catalog/notice; that result must not be injected into model context without logging it. There is no local child Agent or child session transcript.

Continuation creates another standard external activation and is authorized against the exact live original parent, the configured logical agent and the latest successful child. Overlap and stale/foreign references are rejected. A definitely unsent failure leaves the old tail available for explicit retry; any dispatched failure invalidates that conversation, even if the HTTP rejection is definite. Continuation is not the standard local `sendMessage` operation. The caller signal controls managed startup only; after publication use the returned activation's `dispose()` or the standard authorized interrupt. Provider unload stops admission, aborts all active operations and awaits their transport/body cleanup; late credential settlement cannot dispatch HTTP and its rejection remains observed by the provider.

<a id="failure-handling"></a>
## Failure handling

Admission and configuration failures reject with `ExternalAgentError` or the standard Cordis/subagent validation error. Accepted calls resolve a `SubagentResult` with no output on failure: `aborted` for cancellation/unload, otherwise `error`. Provider-owned errors and retained records contain a stable failure `code`, an effect of `not-sent`, `rejected` or `unknown`, and an optional HTTP status. Diagnostics never copy remote bodies, transport messages or credential errors. Cancellation cannot promise remote rollback; timeout, transport loss, malformed responses and partial results after dispatch are unknown outcomes. Check the remote platform before deciding whether to start a new independent call.

<a id="integration-and-verification"></a>
## Integration and verification

The integration owner must add the source/package resolution and aggregate TypeScript reference, refresh workspace/lockfile dependencies, declare this optional provider in the selected bundle/profile resolver manifest, supply the Host overlay, and classify the package in product-package policy. No shipped default profile is changed by this package. Browser execution, browser credential access and generic settings exposure of private deployment config are not part of its API.

Focused HTTP fixtures and a keyless real Loader/headless-profile composition cover successful and failed parent delivery reconstructed from persisted logs. Run from the repository root without triggering a package-manager install:

```sh
node ./node_modules/vitest/vitest.mjs run packages/company/external-agent-subagent/tests
node ./node_modules/typescript/bin/tsc -p packages/company/external-agent-subagent/tsconfig.json --noEmit --incremental false --composite false
```

<a id="model-experience"></a>
## Model Experience

### External app task

#### What the model sees

The external app receives the supplied standalone task text and configured input variables, plus its own platform-owned conversation history on explicit continuation. No parent context is seeded; the platform determines its prompts and model requests.

#### Token effect

Input growth is bounded in encoded request bytes, not model tokens. External prompts, tool traffic, token accounting and answer generation belong to the platform; this provider makes no local child model request.

#### KV Cache effect

Fresh calls use independent platform conversations. Explicit continuation may reuse platform-owned history, but this provider makes no cache-reuse guarantee and does not manage remote KV state.

### Parent settlement through the subagent manager

#### What the model sees

Only the validated answer or a safe failure diagnostic reaches the parent via the existing logged settlement carrier. The tool receipt and settlement envelope are owned by the normal subagent tool/runtime. Provider failure text is exactly `External agent call failed ({code}; effect: {effect}). ` followed by `The remote outcome is unknown; check the platform before starting a new call.` for unknown effects, otherwise `Check the agent configuration or input before starting a new call.`

#### Token effect

Success adds the retained answer subject to the configured complete-result byte cap; failures add a bounded diagnostic instead of partial output. The standard carrier adds its own envelope tokens. Caller-only delivery adds no model context automatically.

#### KV Cache effect

Logged settlement is append-only in the parent conversation and preserves its existing reusable prefix. Answer/diagnostic changes affect the appended suffix; deployment changes do not rewrite earlier parent messages. Provider cache availability and eviction remain outside this package's guarantees.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Live-only provider records** — detailed digests, failures, deployment identity and remote continuation state are process-local. Only the standard parent catalog/result carrier is persisted; unloading or restarting does not restore remote continuation. Capacity exhaustion requires an explicit lifecycle/configuration decision, not silent eviction.
- **Dify blocking apps only** — Chatbot/Chatflow apps are supported; Agent apps requiring streaming fail. There is no project API, workflow execution, streaming, structured result, remote cancellation or automatic replay.
- **Private Host deployment** — no browser registration or UI control is supplied. Integration must keep endpoint/input/credential-reference config out of generic browser configuration exports and enforce external app permissions separately.
- **Build and live-platform validation** — root resolution/classification and aggregate build wiring are integration-owned; the fixture is source-plane only. Real Dify credentialed smoke tests and installed-artifact validation are not supplied by these keyless HTTP tests.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
