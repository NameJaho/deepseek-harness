---
kind: upgrade-guide
description: "WeCom robot publication now uses member-scoped releases and the /发布企微 command."
---

# WeCom robot publication uses member-scoped releases

English | [中文](guide.zh.md)

## Change

The company profile now provides `@deepseek-ai/dsh-company-wecom`. A member starts publication with `/发布企微` from an owned Cloud Agent conversation. The command creates a scan request for the exact published release; it no longer publishes through a model-facing `wecom_publish` tool. Robot bindings, credentials and robot Sessions are filtered by the authenticated member scope.

## Migration

1. Add the `company-wecom` patch after the `company-wecom-auth`, MCP provider and Cloud Agent patches. Set the WebSocket endpoint and deployment limits in the patch or deployment environment.
2. Use `/创建智能体` and `/发布智能体` for Cloud Agent authoring, then run `/发布企微` after a release is published. Existing English command names remain accepted as compatibility aliases.
3. Reauthorize existing robots when their stored records do not contain an owner scope. Do not assign an old binding to a member from the current browser session; restore it as `local-owner` or perform an explicit reviewed data migration.
4. Confirm the member sees only their pending requests and bindings, the robot starts the pinned release, and MCP calls fail when the member loses access or a pinned schema changes.
