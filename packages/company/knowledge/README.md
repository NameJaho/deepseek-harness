---
description: "Approved company knowledge sources over an external HTTP retrieval service, with an owner test page and Cloud Agent release bindings."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-knowledge

English | [中文](README.zh.md)

## Summary

This package defines `ctx.companyKnowledge`, the only Host path that searches company knowledge spaces. The Host configures each logical source with a private search endpoint, an optional bearer credential and an allowlist of upstream spaces. Browsers and models see only the source id, name, description and validated evidence. Cloud Agent drafts select sources; each release stores a fingerprint of the allowed spaces, and its runtime searches only through that fingerprint. Owners can test sources from **Plugins → Company knowledge**. This package connects an existing search service; it does not import documents or manage spaces.

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

Apply `cordis.patch.yml` to a Web profile and set `DSH_COMPANY_KNOWLEDGE_SOURCES` in the server environment to a JSON array of sources. An unset variable leaves the page in its unconfigured state. Each source has `id` (lowercase letters, digits and `-`, at most 64 characters), `name`, optional `description`, `searchUrl` (HTTP or HTTPS without embedded credentials), optional `tokenRef` and a nonempty `spaceIds` list. When the service needs a bearer token, store it under the credential reference named by `tokenRef`; it is resolved through `ctx.credentials` for every request, and an unset credential sends no `Authorization` header. Invalid URLs and duplicate ids reject activation without echoing the URL.

```json
[{ "id": "operations", "name": "Operations manuals", "description": "Store equipment and procedures",
   "searchUrl": "https://knowledge.internal/search", "tokenRef": "DSH_KNOWLEDGE_TOKEN", "spaceIds": ["ops-space"] }]
```

| Field | Default | Meaning |
|---|---|---|
| `sources` | `[]` | Host-owned logical sources with private endpoints, credentials and space allowlists |
| `topK` | `5` | Requested passages, from 1 to 50 |
| `minimumScore` | `0.5` | Minimum accepted rerank relevance |
| `timeoutMs` | `30000` | Deadline for one retrieval |
| `maxQueryChars` | `16000` | Maximum question characters after trimming |
| `maxResponseBytes` | `8388608` | Complete upstream response byte limit |

Each search sends `POST searchUrl` with `{ query, space_ids, top_k, mode: "hybrid", rerank: true }`. The response must be `{ results, total_hits }`; each result has `chunk_id`, `document_id`, `doc_title`, `breadcrumb`, `content`, `score` from 0 to 1 and `space_id`. A result from a space outside the allowlist, more results than `top_k`, a total below the result count, a non-UTF-8 body or a body over the byte limit rejects the whole response. Passages below `minimumScore` and blank passages are removed, and identical content is returned once. An empty result means no reliable evidence was found; it does not establish that a space exists. Transport, HTTP, timeout, credential and response failures stay failures with the codes `company-knowledge/search-failed` and a `reason`; they never become empty evidence and never include URLs, tokens or upstream bodies.

`catalog()` and `test()` are owner-only Remote methods for the management page. The page shows source cards with the latest test status, a question form with a character count and cancellation, and evidence cards with document title, section path, relevance and the complete passage. A failed search keeps the previous result visible. Same-process consumers call `sources()`, `binding(id)`, `validate(binding)` and `search(binding, query, signal)`. Changing a source's space list fails `validate` with `company-knowledge/binding-changed` until a new release is published; document updates inside the same spaces do not require republication.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`CompanyKnowledgeService` is the Service Definition and its HTTP retrieval is the Service Provider; the management page and Cloud Agent are consumers. A binding fingerprint is the SHA-256 of the sorted, deduplicated space list. `search` validates the binding and the query before any request, then joins the caller signal, the plugin lifetime and the per-request deadline. Requests use `redirect: 'error'`. The response is read completely under the byte limit with strict UTF-8 decoding and validated before any evidence is accepted. Plugin disposal aborts and drains admitted requests.

The browser controller allows one catalog load and one search at a time. It keeps the last catalog and result after failures, classifies failures as load, search, timeout or changed source, and ignores the outcome of a cancelled search. Disposal aborts and drains its requests before the Remote namespace is unmounted.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Cloud Agent](../cloud-agent/README.md) — draft source selection and release bindings.
- [Cloud Agent runtime](../cloud-agent-runtime/README.md) — the `cloud_knowledge` tool and its prompt line.
- [Company packages](../README.md) — company integrations.

-----

<a id="model-experience"></a>
## Model Experience

### Approved retrieval evidence

#### What the model sees

This plugin contributes no prompt or tool schema. The [Cloud Agent runtime](../cloud-agent-runtime/README.md#model-experience) owns the `cloud_knowledge` tool and returns this plugin's passages, document titles, section paths and relevance scores. Endpoints, credentials and space ids never enter model parameters or results.

#### Token effect

The calling tool adds the selected evidence to the Session. `topK` and `maxResponseBytes` bound each retrieval.

#### KV Cache effect

Retrieval does not change the instruction prefix or tool definitions. Each result adds ordinary tool history, which changes only the uncached suffix of later requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Document ingestion, index construction and space management belong to the upstream service; the page only tests retrieval.
- Only the HTTP search protocol is implemented. A Streamable HTTP MCP knowledge service needs a separate adapter that reuses the same evidence records and failure codes.
- Real connectivity and relevance thresholds need checks against the deployed service; local fixtures cover the protocol and isolation rules.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
