# Agent Note: Trusted gateway user identity bridge

Status: implemented

English | [中文](2026-10-31-gateway-user-identity-bridge.zh.md)

## Problem

Some company deployments authenticate users at an upstream portal rather than through the DSH WeCom OAuth page. The portal contract supplies URL-encoded `X-User-Info` JSON with `userId` and `userName`; it does not supply a DSH session cookie or a login API. DSH therefore could not show the portal user's name or provide a portal logout destination.

## Decision

The WeCom authentication bundle keeps its local OAuth flow and adds an opt-in gateway identity mode. When enabled, the Host accepts `X-User-Info` only as a trusted reverse-proxy assertion, validates `userId` and `userName`, creates a deterministic private Workspace identity, and applies the same member Remote policy. The browser receives the validated name through the existing `__DSH_WECOM_SESSION__` injection and `/auth/me` response.

Gateway sessions do not create a local cookie. Account pages use the required `gatewayLogoutUrl`; local WeCom sessions continue to use `/auth/wecom/logout`. The mode is disabled by default and must only be enabled when the public listener is protected by a proxy that strips client-supplied identity headers.

## Alternatives considered

**Replace WeCom OAuth with the portal contract.** The contract documents identity injection, not login, token issuance, or logout. Replacing OAuth would leave direct deployments without authentication and would make DSH depend on an unspecified gateway.

**Trust `X-User-Info` in every deployment.** A browser can forge an ordinary HTTP header when it reaches DSH directly. The mode is therefore opt-in and deployment-owned; the proxy must be the only route to the listener.

**Display the header without applying Workspace policy.** This would show a name while leaving authorization tied to the Owner or another session. Gateway identities instead receive the same per-user Workspace and Remote restrictions as local members.

## Consequences

Portal identity provisioning is asynchronous because Workspace persistence is asynchronous; the first browser load may need the normal client retry while the private Workspace is created. Gateway logout remains owned by the portal and requires an explicit configured URL. The `X-Operate-Info` permission context is not treated as identity. The default WeCom OAuth path and local logout behavior remain unchanged.
