# Agent Note: MCP Market member authorization

Status: implemented

English | [中文](2026-10-31-mcp-market-member-authorization.zh.md)

## Problem

The MCP Market directory and execution routes must reflect the authenticated WeCom member. A browser supplied subject, a shared catalog, or a release owner's credentials would let one member discover or execute another member's MCPs.

## Decision

The Host resolves a `WecomMarketSubject` from the verified WeCom Principal or the retained owner of the initiating Session. The browser Remote has no subject field. The MCP provider sends that subject together with a deployment service credential to Market-owned internal page, detail, and invoke routes. The Market performs visibility, publication, and usage authorization.

DSH reads the member's existing Market permissions without storing local enablement preferences or exposing application or authorization actions. Failed authorization or refresh clears the catalog. Cloud Agent publication stores schema fingerprints; starting a release and each invocation recheck current authorization, publication and fingerprint. A public release therefore runs with the current member's rights.

## Alternatives considered

A shared gateway catalog was simpler, but it could not distinguish members when the backend request did not carry a verified identity. Reading the public MCP endpoint configuration would expose creator-only data and would not establish usage authorization. Passing `sub` from a Remote argument was rejected because the caller could select another identity.

## Consequences

The DSH side keeps service credentials and Market routes private, and model-visible data contains only authorized MCP metadata and results. The Market backend must deploy the three internal routes and accept the DSH service credential. Local fixtures verify the DSH contract; production connectivity remains deployment work.
