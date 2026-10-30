# Agent Note: WeCom member-specific default Workspaces

English | [中文](2026-10-30-wecom-member-workspace-isolation.zh.md)

Status: implemented

## Problem

WeCom login created a `wecom-user` principal without a Remote policy. Members therefore could not receive the Session, Workspace, settings, or plugin inventory data required by the client. Sharing one default Workspace would also expose members to each other’s Sessions.

## Decision

`dsh-company-wecom-auth` creates one deterministic Workspace directory for each enabled member: `<workspaceRoot>/<identityId>`, with the fixed display title `default`. Login ensures the Workspace exists before admitting the local Session; service startup restores Workspaces for saved members as well.

The Remote policy binds only that Workspace and its `sessionIds`. The list and Workspace stream controllers continue filtering by their resource checks, so each member receives only their own Workspace and Sessions. `session/create` accepts only the member’s Workspace and rejects a raw `cwd`; members receive no Workspace deletion or arbitrary directory registration grant. `workspaceRoot` comes from `DSH_WECOM_WORKSPACE_ROOT`, and the test launcher defaults it to `$DSH_BASE/workspaces`.

The browser index injection uses the client’s `__DSH_WECOM_SESSION__` key. The client adds the member name to the existing sidebar footer and starts a new login after `/auth/me` confirms that the local session is no longer admitted.

## Alternatives considered

A global policy for every WeCom member would restore the page quickly but expose other members’ Sessions and Workspaces, so it does not meet the isolation requirement. Adding owner metadata to the persisted Session format would express finer ownership but expand the Session migration surface; the existing Workspace membership relation is sufficient for this default conversation flow.

## Consequences

Members must create Sessions through their own Workspace; historical Sessions that do not belong to it remain hidden. The Workspace root must be writable and readable by the service account, and Remote snapshots are recomputed after Workspace or domain changes. Owners manage deletion or relocation of member Workspaces so members cannot remove their own default entry.
