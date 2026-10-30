---
kind: upgrade-guide
description: "WeCom members now receive one server-managed default Workspace and need the updated login permissions for settings and plugin pages."
---

# WeCom members use a server-managed default Workspace

English | [中文](guide.zh.md)

## Change

WeCom members no longer create or browse host directories. Each member receives one private `default` Workspace under the server-managed root, and the browser hides its filesystem path. The member Remote policy now grants the settings, model, plugin inventory, plugin manager, and plugin market endpoints required by the existing UI. The login projection also exposes the member name, user ID, corporation ID, and a reserved `admin`/`user` role.

## Migration

1. Pull the `login` branch and rebuild the Host and Client artifacts.
2. Keep `DSH_WECOM_WORKSPACE_ROOT` writable by the service account. Do not add a directory-picker or Workspace-creation permission to the member policy.
3. Restart the test service and sign in again. Confirm that the sidebar shows the member's `default` Workspace, Settings and Plugins are present, and `/auth/me` returns `role: "user"`.
