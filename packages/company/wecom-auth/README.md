---
description: "Required official WeCom self-built application login for the company Web deployment."
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-wecom-auth

English | [中文](README.zh.md)

## Summary

This opt-in layer lets visible members of a self-built WeCom application sign in to the Web site. WeCom browsers use silent OAuth; desktop browsers receive an official QR panel in the enterprise portal's branded layout, with a packaged background image and a responsive single-column layout on narrow screens. Only QR sign-in is offered; password and verification-code sign-in are not configured. The test deployment launcher applies this layer and denies Owner launch credentials. The server verifies application visibility before issuing a local session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The repository's `start-dsh-test.sh` applies `cordis.patch.yml` to an independent Web profile. Set `DSH_WECOM_CORP_ID`, `DSH_WECOM_AGENT_ID`, `DSH_PUBLIC_URL` and, when needed, `DSH_WECOM_WORKSPACE_ROOT` for another deployment. The launcher defaults to CorpId `ww2ec793812513c257`, AgentId `1000239`, `https://test-hmwork.busyming.com/`, and `$DSH_BASE/workspaces`. The plugin requires a bare HTTPS origin and serves authentication at the origin root.

For the local WeCom OAuth mode, set `DSH_WECOM_APP_SECRET` exclusively in the server process environment using the rotated self-built application secret. Never put it in YAML, a profile, browser code, command-line arguments or logs. Plugin configuration has no secret field. Missing secret or invalid identifiers reject activation; the launcher refuses to start without a secret, including when gateway identity is enabled.

Configure `test-hmwork.busyming.com` as the self-built application's trusted OAuth domain and Web login domain, configure application visibility, and permit the server's egress IP in WeCom's trusted-IP settings. The TLS reverse proxy must preserve the public `Host`, forward the root and `/auth/` routes, and support the ordinary Web API and WebSocket routes. The callback is `https://test-hmwork.busyming.com/auth/wecom/callback`. Do not log callback query strings. A deployment administrator must verify real QR/OAuth login after configuring the rotated secret; automated tests use no real WeCom credentials.

`GET /login?redirect=/path` starts login. `GET /auth/me` returns the current member or 401. `POST /auth/wecom/logout` requires the public `Origin` and `X-DSH-Auth: 1`, revokes the local session and clears its cookie. External redirect values become `/`; permitted path and query values survive login except credential parameters.

When `gatewayIdentityEnabled` is true, the deployment may sit behind a trusted portal gateway that strips incoming identity headers and injects URL-encoded `X-User-Info` JSON with `userId` and `userName`. DSH validates those fields, creates the same private Workspace policy, and exposes the name through `/auth/me` and the account page. Requests without a valid `X-User-Info` continue through WeCom OAuth, so enabling the mode does not block direct logins. `gatewayLogoutUrl` is required and points to the portal's logout destination. Never enable this mode on a listener reachable without the gateway: `X-User-Info` is an assertion from the trusted proxy, not a browser credential, and the application cannot distinguish a spoofed direct request.

The layer sets Connection's `requireBrowserLogin: true`. Owner browser cookies, root launch tokens and `/connect` credentials cannot admit a public caller, even after the login provider unloads. Each member receives one durable `default` Workspace below `DSH_WECOM_WORKSPACE_ROOT`; Remote lists and commands are filtered to that Workspace and its Sessions, and `session/create` rejects another Workspace or a raw `cwd`. The member principal remains `wecom-user`, not Owner.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Login stores hashed unpredictable state and a hashed HttpOnly browser binding. Callback reserves and durably consumes that state before calling official `gettoken` and `auth/getuserinfo`. The provider checks active membership with `user/get`, then uses `agent/get` visibility lists, `tag/get` membership and department ancestors from `department/list`. Missing fields, API permission failures and upstream errors deny login rather than treating corporation membership as sufficient.

The provider caches one application access token in server memory, independently of member sessions. Identity and session records contain no app secret, code or access token. The credential provider retains only the local cookie signing key. A signed host-only `HttpOnly; Secure; SameSite=Lax` cookie references the durable local session. Login restores or creates the member's deterministic Workspace directory before admitting the Peer. Workspace changes invalidate Remote snapshots so a new Session appears only for its owner. Logout and expiry revoke the member Peer and its streams. Storage failures return sanitized failures; failed durable revocation requires storage repair before restarting.

</details>

-----

<a id="model-experience"></a>
## Model Experience

### Authentication

#### What the model sees

The authentication layer adds no member identity or login data to model context; `wecom-user` is used only for Remote admission.

#### Token effect

The authentication layer adds no model request content or token usage.

#### KV Cache effect

The authentication layer does not change model request caching.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Visibility is verified at login; changes to application visibility take effect on the next login or local session expiry (default eight hours).
- The layer does not grant Owner privileges. Existing Workspaces and Sessions created outside a member's private Workspace remain unavailable to that member.
- Authentication mounts at the public origin root; subpath deployments are not supported.
- The official QR SDK requires browser access to WeCom CDN and panel domains. API access requires the app's directory/tag permissions; unavailable permissions deny login.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
