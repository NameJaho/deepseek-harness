---
kind: upgrade-guide
description: "WeCom members now use isolated default Workspaces, requiring a writable workspace root and migration of member data."
---

# WeCom members use isolated default Workspaces

English | [中文](guide.zh.md)

## Change

Previously, a WeCom deployment did not provide each member with a visible Workspace and could not safely expose member Sessions through Remote access. The login layer now creates one persistent `default` Workspace per enabled member below `DSH_WECOM_WORKSPACE_ROOT` and filters Workspace and Session access to that member. A member cannot create a Session with another `workspaceId` or a raw `cwd`.

## Migration

1. Give the service account read, write, and execute access to the directory configured by `DSH_WECOM_WORKSPACE_ROOT`. The test launcher defaults this to `$DSH_BASE/workspaces`; set an absolute path when the deployment needs another location.
2. Keep existing member data under the same root, or move each member directory to `<workspaceRoot>/<identityId>` before restarting. The identity id is the stable `i-...` value stored by the WeCom auth domain.
3. Restart the Web profile and sign in again. Confirm that the member sees exactly one Workspace titled `default`, can create a Session there, and cannot access another member's Workspace or Session.
