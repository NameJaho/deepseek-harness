---
description: "Hides four dsh-context elements in the Web client: the Overview settings and update links, the Plugin Info card, and the Thanks card."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dsh-context-hidden-entries

English | [中文](README.zh.md)

## Summary

Appends one stylesheet that hides four elements rendered by the third-party `dsh-context` plugin. The Web bundle loads this package; removing it from the bundle restores the plugin's elements.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The `@deepseek-ai/dsh-web-app` bundle loads this package by default. The hidden elements are:

- Overview page header: the plugin settings button (`.lc-ov-settings`) and the update link (`.lc-ov-update`).
- Conversation Context tab: the Plugin Info card (`.lc-card:has(> .lc-pi-grid)`) and the Thanks card (`.lc-recom`).

The selectors target class names of `dsh-context@0.81.2`. A different plugin version may rename them, and the elements then reappear.

The hiding is visual only. The plugin still renders the hidden Thanks card, so its recommendation request to `gh-proxy.org` still runs.

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Selectors depend on `dsh-context` internals. Re-verify them after each `dsh-context` upgrade.
- Hiding does not prevent the plugin's network requests. Removing the Thanks card's fetch requires changing the plugin or removing the plugin.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
