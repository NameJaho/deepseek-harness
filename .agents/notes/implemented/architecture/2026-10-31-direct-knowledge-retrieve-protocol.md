# Agent Note: Direct knowledge retrieve protocol

Status: implemented

English | [中文](2026-10-31-direct-knowledge-retrieve-protocol.zh.md)

## Problem

The company knowledge provider was sending an older single-question response contract, while the deployed knowledge service exposes the direct `knowledge_search_api/retrieve` endpoint. The older request discarded conversation method state and the response omitted sufficiency, conflict, method and source-group signals.

## Decision

Company knowledge uses the direct retrieve endpoint configured by each logical source. The Host injects the approved `space_ids`, sends the complete user/assistant `messages` history, and carries `emotion`, `prev_method_id`, `verify`, image, source and filtering controls when provided. The direct endpoint is an internal unauthenticated service; no bearer token is configured or forwarded by this package.

The Host validates the retrieve envelope and approved document spaces, retains grouped `chunks`, `images`, `im` and `graph` results plus retrieve signals for Cloud Agent execution, and projects only bounded evidence fields to the management Remote. Cloud Agent derives prior conversation messages and the previous method id from the current Session before invoking retrieval.

## Alternatives considered

**Keep the old `query` request and map the new endpoint behind it.** This loses multi-turn method continuity and makes `verify`, source selection and direct response signals unavailable to the model.

**Expose the full retrieve response through the browser Remote.** This would publish internal source groups and unbounded upstream fields to the client. The Host keeps detailed results in the same-process execution result and returns bounded evidence through the management API.

## Consequences

Deployments must provide the direct retrieve URL and approved space ids. The internal endpoint must be protected by the deployment network because this integration does not add request authentication. Retrieval tests cover multi-turn request fields, method signals, source groups, filtering and response validation.
