# Agent Note: Member upload route authorization

Status: implemented

English | [中文](2026-11-02-member-upload-route-authorization.zh.md)

## Problem

The raw `/api/session/uploadFileBinary` route rejected every authenticated non-owner Peer before the upload handler ran. WeCom members therefore could not upload files even though their Session access policy granted `fileUploads/upload`; a reverse proxy could surface the early connection close as HTTP 502.

## Decision

The exact upload route allows non-owner Peers through Connection's authentication fence and authorizes the requested Session inside the file-upload package with the existing `fileUploads/upload` action and Session resource. Authorization runs before the request body is consumed. Owners continue to pass, members with a grant upload only to the addressed Session, and denied members receive 403 without invoking storage. The generated Remote upload API remains unchanged.

## Alternatives considered

- **Keep the route owner-only and rely on the Remote fallback.** Rejected: Blob and stream uploads use the raw route, and the browser cannot transparently convert those one-shot bodies into the encoded Remote payload without losing the streaming path.
- **Authorize only in the browser or only after storage resolves the Agent.** Rejected: either path can be bypassed by a direct HTTP caller or consumes/stores unauthorized bytes before the decision.
- **Add a second member-only upload endpoint.** Rejected: duplicating the route would split authentication, streaming, cancellation, and response behavior; the existing access policy already names the correct action and resource.

## Consequences

The upload route now depends on `remoteAccess` and carries the authenticated Peer into its handler. Unauthorized streaming requests are rejected before body consumption, preserving storage and backpressure guarantees. Existing owner uploads, encoded Remote calls, Session receipt handling, and wire formats remain unchanged. The route's non-owner authorization is covered by Host tests, while the existing WeCom and Session upload suites verify composition and lifecycle behavior.
