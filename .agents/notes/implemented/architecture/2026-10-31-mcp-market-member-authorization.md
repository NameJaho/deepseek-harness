# Agent Note: MCP Market member authorization

Status: implemented

English | [中文](2026-10-31-mcp-market-member-authorization.zh.md)

## Problem

The MCP Market directory and execution routes must reflect the authenticated WeCom member. A browser supplied subject, a shared catalog, or a release owner's credentials would let one member discover or execute another member's MCPs.

## Decision

The Host resolves a `CompanyMarketSubject` from the verified company Principal or retained Session owner. The browser Remote has no subject field. The MCP provider uses the Market's existing HR read to map official WeCom ids to portal accounts, or portal accounts to WeCom ids. Exact identity matches are required. The existing list establishes publication and visibility; the existing permission check establishes usage rights for the resolved WeCom subject.

DSH reads existing permissions without storing enablement preferences or exposing application or authorization actions. Failed identity resolution or refresh clears the directory. Tool schemas load only on explicit discovery, so gateway schema failures do not hide the member's directory. Actual MCP invocation is deferred and fails before any invocation request; directory access is not a transport credential.

## Alternatives considered

A shared gateway catalog was simpler, but it could not distinguish members when the backend request did not carry a verified identity. Reading the public MCP endpoint configuration would expose creator-only data and would not establish usage authorization. Passing `sub` from a Remote argument was rejected because the caller could select another identity.

New member-directory and execution endpoints with a service token could centralize this work, but those endpoints and credentials are absent from the supplied Market API. The adapter therefore reuses existing read APIs. Treating the WeCom id as the portal user id would avoid a lookup but would join different identity namespaces and select the wrong account. Using only the permission check would miss its lack of a publication check.

## Consequences

The adapter needs a unique active HR-to-portal mapping and trusted internal access to existing backend reads. Public portal gateway authentication and MCP execution remain separate integration work. Local fixtures verify member isolation, exact mapping, published candidate reads and permission changes; production connectivity is not verified.
