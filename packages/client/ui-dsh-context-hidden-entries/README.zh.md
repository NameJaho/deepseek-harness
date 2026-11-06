---
description: "在 Web 客户端隐藏 dsh-context 的四个元素：概览页的设置和更新链接、插件信息卡片与感谢卡片。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dsh-context-hidden-entries

[English](README.md) | 中文

## 概述

追加一张样式表，隐藏第三方插件 `dsh-context` 渲染的四个元素。Web 包会加载本包；从包中移除后，插件元素恢复显示。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`@deepseek-ai/dsh-web-app` 包默认加载本包。隐藏的元素如下：

- 概览页标题栏：插件设置按钮（`.lc-ov-settings`）和更新链接（`.lc-ov-update`）。
- 会话 Context 标签页：插件信息卡片（`.lc-card:has(> .lc-pi-grid)`）和感谢卡片（`.lc-recom`）。

选择器对应 `dsh-context@0.81.2` 的类名。其他插件版本可能改名，元素会重新出现。

隐藏只作用于显示。插件仍会渲染被隐藏的感谢卡片，因此它向 `gh-proxy.org` 发起的推荐请求依然执行。

<a id="model-experience"></a>
## 模型体验

无，本包只提供浏览器展示，不会进入模型请求。

#### KV 缓存影响

无；本包既不组装也不发送 Provider 请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 选择器依赖 `dsh-context` 的内部实现。每次升级 `dsh-context` 后需要重新核对。
- 隐藏不会阻止插件的网络请求。要去掉感谢卡片的请求，需要修改插件或移除插件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作背景——点击展开</summary>

无。

</details>
