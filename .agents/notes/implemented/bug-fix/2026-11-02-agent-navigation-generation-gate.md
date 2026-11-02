# Agent Note: Keep caller-scoped Agent navigation registered across connection generations

Status: implemented

English | [中文](2026-11-02-agent-navigation-generation-gate.zh.md)

## Problem

Cloud Agent conversations have separate physical Workspace registrations that must be projected into one caller-scoped Agent row. During Client startup or connection replacement, the Agent navigation provider was absent while its private catalog UI was being mounted, so the sidebar rendered those physical rows before the catalog projection collapsed them.

## Decision

The Cloud Agent client registers one navigation gate for the lifetime of its connected UI host. The gate returns `undefined` before a connection generation's catalog provider is ready and while that generation is being replaced, so `WorkspaceNavigationGroups` keeps the navigation projection pending instead of falling back to physical Workspace rows. Each generation still owns its controller and catalog provider; replacing or disposing that provider only changes the gate source, and the gate unregisters when the Cloud Agent plugin itself unloads.

## Alternatives considered

**Keep unregistering and rely on the Workspace browser phase.** The browser phase only describes the physical Workspace stream and cannot observe a capability provider that has already been removed, so it still exposes physical rows during the lifecycle gap.

**Keep the old Agent catalog during reconnect.** A catalog from the previous connection generation can belong to a different authenticated principal, so stale groups must be withheld rather than displayed while the new catalog is loading.

## Consequences

The sidebar remains empty for the short interval between connection generations and then renders the merged Agent groups once the caller-scoped catalog settles. Physical Workspace rows still return when the Cloud Agent plugin is unloaded, and catalog failure resolves to the existing ungrouped physical projection. The gate adds one in-memory observer and does not change Workspace or Cloud Agent persistence, wire data, or authorization.

## Verification

The navigation tests cover source replacement through `undefined`, the replacement source, and observer cleanup. The focused ui-workspace and Cloud Agent suites pass with 548 tests, the repository typecheck passes, and the repository lint gate passes with its existing unrelated warning.
