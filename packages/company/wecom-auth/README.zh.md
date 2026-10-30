---
description: "公司 Web 部署使用的企业微信自建应用官方 API 强制登录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-wecom-auth

[English](README.md) | 中文

## 概述

此可选层让企业微信自建应用可见范围内的成员登录 Web 站点。企业微信浏览器使用静默 OAuth，桌面浏览器在企业门户品牌布局中显示官方二维码面板，背景素材随包分发，窄屏采用单列布局。页面仅提供扫码登录，未配置密码或验证码登录。测试部署启动器应用此层并拒绝 Owner 启动凭据。服务端验证应用可见范围后才签发本地会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

仓库的 `start-dsh-test.sh` 将 `cordis.patch.yml` 应用到独立 Web profile。其他部署可设置 `DSH_WECOM_CORP_ID`、`DSH_WECOM_AGENT_ID` 和 `DSH_PUBLIC_URL`。启动器默认使用 CorpId `ww2ec793812513c257`、AgentId `1000239` 和 `https://test-hmwork.busyming.com/`。插件要求纯 HTTPS origin，并在 origin 根路径提供认证。

仅在服务端进程环境中设置 `DSH_WECOM_APP_SECRET`，使用轮换后的自建应用 Secret。不得放入 YAML、profile、浏览器代码、命令行参数或日志。插件配置没有 Secret 字段。缺失 Secret 或标识符非法会拒绝激活；启动器在没有 Secret 时拒绝启动。

将 `test-hmwork.busyming.com` 配置为自建应用的 OAuth 可信域名及 Web 登录域名，配置应用可见范围，并在企业微信可信 IP 设置中允许服务端出口 IP。TLS 反向代理必须保留公网 `Host`，转发根路径及 `/auth/` 路由，并支持常规 Web API 和 WebSocket 路由。回调为 `https://test-hmwork.busyming.com/auth/wecom/callback`。不得记录回调查询参数。配置轮换后的 Secret 后，部署管理员必须验证真实扫码及 OAuth 登录；自动测试不使用真实企业微信凭据。

`GET /login?redirect=/path` 开始登录。`GET /auth/me` 返回当前成员或 401。`POST /auth/wecom/logout` 要求公网 `Origin` 和 `X-DSH-Auth: 1`，撤销本地会话并清除 cookie。外部重定向值变为 `/`；合法路径和查询参数在登录后保留，凭据参数除外。

此层设置 Connection 的 `requireBrowserLogin: true`。Owner 浏览器 cookie、根路径启动令牌和 `/connect` 凭据均不能接纳公网调用方，即使登录提供方卸载也不会恢复。成员 principal 保持 `wecom-user`，不是 Owner；业务 Remote 权限必须通过独立的显式策略授予。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

登录保存不可预测 state 的哈希及 HttpOnly 浏览器绑定的哈希。回调先预占并持久化消费 state，再调用官方 `gettoken` 和 `auth/getuserinfo`。提供方通过 `user/get` 验证活跃成员，再根据 `agent/get` 可见名单、`tag/get` 成员及 `department/list` 中的部门祖先验证可见范围。缺失字段、API 权限不足及上游错误均拒绝登录，不会将企业成员身份视为充分条件。

提供方仅在服务端内存中缓存一个应用 access token，与成员会话相互独立。身份和会话记录没有应用 Secret、code 或 access token。凭据提供方仅保留本地 cookie 签名密钥。签名后的 host-only `HttpOnly; Secure; SameSite=Lax` cookie 引用持久化本地会话。退出及过期会撤销成员 Peer 和流。存储失败返回脱敏错误；持久化撤销失败时，必须修复存储后再重启。

</details>

-----

<a id="model-experience"></a>
## 模型体验

无；认证不组装模型请求，也不添加提示内容。

#### KV Cache 影响

无；登录不改变模型请求缓存。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 登录时验证可见范围；应用可见范围变更在下次登录或本地会话过期时生效，默认八小时。
- 此层建立身份，不授予业务权限。官方 Web profile 不会自动授予成员 Owner 权限或既有业务资源访问权限。
- 认证挂载于公网 origin 根路径；不支持子路径部署。
- 官方二维码 SDK 要求浏览器可访问企业微信 CDN 和面板域名。API 访问要求应用具有目录和标签权限；权限不足会拒绝登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
