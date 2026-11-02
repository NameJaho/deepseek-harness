---
description: "Publish saved Cloud Agents to WeCom robots through official scan authorization and persistent text conversations."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-wecom

English | [中文](README.zh.md)

## Summary

Publish a saved Cloud Agent to a WeCom intelligent robot by scanning the official authorization window. The robot uses its authorized immutable release and keeps a durable conversation for each private chat or group. Company launch scripts include this layer alongside Cloud Agent authoring; standard profiles require both patches. The Host needs outbound WebSocket access, and supports text messages only.

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

### Load the company profile layers

This private package is supplied by this checkout. The [company launcher](../../../start-dsh-test.sh) loads its [patch](cordis.patch.yml) after the [Cloud Agent layer](../cloud-agent/README.md#use-this-package). The shipped Web profile also accepts both through ordered `--patch` arguments, as exercised by the [Loader test](tests/profile.spec.ts). The patch inserts the `company-wecom` row and curates the Plugins page to Company MCP, Company knowledge and WeCom robots; override those rows to change deployment settings.

In a Cloud Agent authoring conversation, ask to publish a saved agent to WeCom. The tool publishes a changed draft as an immutable release and returns an authorization card. Click **Scan to publish to WeCom**, allow the popup, and scan in the official WeCom window. The browser sends the returned credentials directly to the Host credential service; do not paste a robot Secret into chat.

Open **Agent information** in a saved Agent conversation to authorize its exact published release, check its actual connection, reconnect or disable the robot. The sidebar request reuses a pending unbound authorization for that release and never publishes draft edits. The company Plugins page shows only Company MCP, Company knowledge and WeCom robots; robot actions remain available from the Agent sidebar. Authorization completes before gateway authentication; only **Online** confirms the gateway acknowledgement. Later publication or withdrawal from Public space does not change an authorized robot's release. Each private chat or group resumes its own Session, and one robot processes messages serially. Group members share the group's conversation history and selected capabilities.

### Configuration and recovery

The `company-wecom` row accepts these settings. Credentials belong in the credential service, never in this configuration.

| Field | Default | Meaning |
|---|---|---|
| `source` | `busyming-ai-harness` | Official authorization source identifier |
| `wsUrl` | `wss://openws.work.weixin.qq.com` | Official gateway; override for a private deployment |
| `authorizationTimeoutMs` | `600000` | Authorization lifetime in milliseconds |
| `responseTimeoutMs` | `240000` | Processing deadline and SDK request timeout in milliseconds |
| `maxBindings` | `20` | Retained robots and maximum simultaneous connections |
| `maxQueuedMessages` | `20` | Pending messages per robot, including the active message |
| `maxInputChars` | `16000` | Maximum inbound text length |
| `maxReplyBytes` | `20000` | UTF-8 reply limit including any truncation notice |
| `maxRequests` | `1000` | Retained authorization requests; expired requests are pruned on authorization |
| `maxConversations` | `1000` | Retained private-chat and group routes |
| `maxReceipts` | `10000` | Retained delivery receipts for duplicate suppression |

Missing credentials or gateway failures leave a robot offline. Restore credentials through authorization, check outbound connectivity, then reconnect. A failed or interrupted submission may already have executed tools: inspect the corresponding Harness Session before repeating an operation. Unconfirmed deliveries are never replayed automatically. A full receipt or conversation store stops new admission; increase its configured limit after checking the logs. Disablement stops new admission, cancels owned active work, and waits for settlement before disconnecting.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [service](src/index.ts) owns authorization requests, credential references, immutable release bindings and hashed conversation routes in the validated `company_wecom` domain. It reserves a durable delivery receipt before enqueueing, retains submission uncertainty across restarts, and resumes Sessions through the existing Session controller. The [channel](src/channel.ts) owns the official Node SDK connection, bounded queue, cancellation and final replies; teardown drains its work before closing storage.

The [browser plugin](src/client/index.ts) mounts generated Remote methods, follows sanitized snapshots, and injects shared state into tool cards, the management page and a shell-owned toast. The [popup](src/client/authorization.ts) follows the official browser SDK protocol while verifying both origin and window identity and removing listeners on every terminal outcome. Credentials never enter observable browser state, tool results or routing records.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Company packages](../README.md) — deployment capabilities and their owners.
- [Cloud Agent](../cloud-agent/README.md) — saved drafts, releases and retained Sessions.
- [Storage domains](../../storage/storage-domain/README.md) — validated non-Session records.

-----

<a id="model-experience"></a>
## Model Experience

### `/发布企微` publication command

#### What the model sees

The `/发布企微` command starts a scan request only for a release owned by the current company member and bound to the current conversation. Pending requests appear in the WeCom page and Agent release actions; no robot binding is saved before authorization completes. Gateway online state remains visible through the Remote page. Release instructions and robot messages reach the selected model through ordinary durable Sessions.

#### Token effect

The command is outside model prompt assembly and adds no model request tokens. Command settlements, robot messages and replies are recorded in the ordinary Session log.

#### KV Cache effect

The command names and input remain stable; a robot's retained release keeps its model and instructions fixed across draft edits and republication.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Real account scanning and acceptance of the configured `source` require verification in the target WeCom environment. Automated tests use a local authorization page and gateway.
- The package supports text only, with no proactive notifications, file delivery, binding deletion or receipt pruning. A robot cannot be rebound to a different release; create a new robot for that release.
- Management is isolated by the verified WeCom member owner scope. Group conversations share that robot's history; MCP tools recheck member authorization and the pinned schema fingerprint before every execution.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
