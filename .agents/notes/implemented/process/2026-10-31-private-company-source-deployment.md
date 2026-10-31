# Agent Note: Private company source deployment

Status: implemented

English | [中文](2026-10-31-private-company-source-deployment.zh.md)

## Problem

Company integrations are configured for a private deployment, while the ordinary package directory policy assumes public npm release membership. Removing `private` to satisfy that assumption would make enterprise packages publishable without a deployment requirement.

## Decision

The six existing company packages are explicit private deployment members in the workspace constraints. They must retain `private: true` and omit `publishConfig`. Shared versions, dependency rules, compiler faces, exports and payload checks still apply. Release discovery already excludes private manifests under the [release sequence policy](2026-08-10-npm-release-sequences.md); that policy remains active and is not superseded.

The deployment runs the source CLI with configured patches. The public npm CLI publication path is not a distribution method for this company fork. A public distribution requires a separate review of company dependency delivery rather than changing the private flags.

Company `/types` entries with no runtime values expose declarations only. They do not publish the compiler’s unbundled browser modules, whose stylesheet imports require the client bundler. The runtime client entry remains the bundled `/client` module. Runtime imports from shared Host providers are classified as peer-required; no duplicate-install-safe exceptions are added.

## Alternatives considered

**Publish company packages as ordinary release members.** This follows the public directory default, but publication is unnecessary for source deployment and would make private integrations eligible for the public registry.

**Exclude the entire company directory from validation.** This avoids maintaining an explicit membership set, but silently admits new private packages and loses useful version and artifact checks. Each additional integration requires explicit classification.

## Consequences

Company deployments use a checkout, the frozen workspace lockfile and the normal artifact build. Constraint regressions reject public flags, publication configuration, stale versions and missing payloads. This scoped exception does not change other release members or remove the release discovery rule that skips private packages.
