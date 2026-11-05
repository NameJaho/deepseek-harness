---
description: "公司 Web 部署使用的企业微信自建应用官方 API 强制登录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-company-wecom-auth

[English](README.md) | 中文

## 概述

此可选层让企业微信自建应用可见范围内的成员登录 Web 站点。企业微信浏览器使用静默 OAuth，桌面浏览器在企业门户品牌布局中显示官方二维码面板，背景素材随包分发，窄屏采用单列布局。面板中的“在企业微信桌面端打开”回调到达企业微信桌面端浏览器且缺少发起浏览器的 cookie 时，回调在该端重新发起一次静默 OAuth。页面仅提供扫码登录，未配置密码或验证码登录。测试部署启动器应用此层并拒绝 Owner 启动凭据。服务端验证应用可见范围后才签发本地会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

仓库的 `start-dsh-test.sh` 将 `cordis.patch.yml` 应用到独立 Web profile。其他部署可设置 `DSH_WECOM_CORP_ID`、`DSH_WECOM_AGENT_ID`、`DSH_PUBLIC_URL`，以及需要时设置 `DSH_WECOM_WORKSPACE_ROOT`。启动器默认使用 CorpId `ww2ec793812513c257`、AgentId `1000324`、`https://hmwork.busyming.com/` 和 `$DSH_BASE/workspaces`。插件要求纯 HTTPS origin，并在 origin 根路径提供认证。

本地 WeCom OAuth 模式仅在服务端进程环境中设置 `DSH_WECOM_APP_SECRET`，使用轮换后的自建应用 Secret。不得放入 YAML、profile、浏览器代码、命令行参数或日志。插件配置没有 Secret 字段。缺失 Secret 或标识符非法会拒绝激活；启动器在没有 Secret 时拒绝启动，启用网关身份时也是如此。

将 `hmwork.busyming.com` 配置为自建应用的 OAuth 可信域名及 Web 登录域名，配置应用可见范围，并在企业微信可信 IP 设置中允许服务端出口 IP。TLS 反向代理必须保留公网 `Host`，转发根路径及 `/auth/` 路由，并支持常规 Web API 和 WebSocket 路由。回调为 `https://hmwork.busyming.com/auth/wecom/callback`。不得记录回调查询参数。配置轮换后的 Secret 后，部署管理员必须验证真实扫码及 OAuth 登录；自动测试不使用真实企业微信凭据。

`GET /login?redirect=/path` 开始登录。`GET /auth/me` 返回当前成员或 401；首页可能按 Owner 共享的浏览器 Peer 渲染，因此首页没有 `__DSH_WECOM_SESSION__` 身份时，侧栏账号入口会读取该接口。`POST /auth/wecom/logout` 要求公网 `Origin` 和 `X-DSH-Auth: 1`，撤销本地会话并清除 cookie；侧栏账号弹窗显示姓名、用户 ID、企业 ID 和角色，调用该接口后打开 `/login`（网关会话跳转 `gatewayLogoutUrl`）。外部重定向值变为 `/`；合法路径和查询参数在登录后保留，凭据参数除外。

当 `gatewayIdentityEnabled` 为 true 时，部署可以位于可信门户网关后面，由网关清除外部身份头并注入包含 `userId` 和 `userName` 的 URL 编码 `X-User-Info` JSON。DSH 会校验这两个字段，使用同一套私有 Workspace 权限策略，并通过 `/auth/me` 和账号弹窗提供用户名称。没有合法 `X-User-Info` 的请求继续走 WeCom OAuth，因此开启该模式不会阻断直接登录。此时必须将 `gatewayLogoutUrl` 设置为门户退出地址。不要在没有网关保护的监听地址上启用此模式：`X-User-Info` 是可信代理的断言，不是浏览器凭据，应用无法分辨直接请求伪造的 header。

此层设置 Connection 的 `requireBrowserLogin: true`。Owner 浏览器 cookie、根路径启动令牌和 `/connect` 凭据均不能接纳公网调用方，即使登录提供方卸载也不会恢复。每个成员都会在 `DSH_WECOM_WORKSPACE_ROOT` 下获得一个持久的 `default` Workspace；Remote 列表和命令只会返回该 Workspace 及其中的会话，`session/create` 也会拒绝其他 Workspace 或原始 `cwd`。OAuth 身份使用 `wecom-user`，可信网关身份使用 `gateway-user`。业务插件分别获得 `wecom:<corpId>:<userId>` 与 `gateway:<userId>` 归属范围，并可为自己管理的会话贡献显式授权。两种身份都不是 Owner。

-----

<a id="understand-the-implementation"></a>
## 理解实现

业务目录可通过 `marketSubject()` 获取已验证调用者或 Session 持久化所有者的 `CompanyMarketSubject`。官方企微和可信门户身份保持分离；[MCP 市场 Provider](../mcp-provider/README.zh.md)解析两者的 HR 映射，不让浏览器传入身份参数。

<details>
<summary>实现内部 — 点击展开</summary>

登录保存不可预测 state 的哈希及 HttpOnly 浏览器绑定的哈希。回调先预占并持久化消费 state，再调用官方 `gettoken` 和 `auth/getuserinfo`。提供方通过 `user/get` 验证活跃成员，再根据 `agent/get` 可见名单、`tag/get` 成员及 `department/list` 中的部门祖先验证可见范围。缺失字段、API 权限不足及上游错误均拒绝登录，不会将企业成员身份视为充分条件。

提供方仅在服务端内存中缓存一个应用 access token，与成员会话相互独立。身份和会话记录没有应用 Secret、code 或 access token。凭据提供方仅保留本地 cookie 签名密钥。签名后的 host-only `HttpOnly; Secure; SameSite=Lax` cookie 引用持久化本地会话。登录会先恢复或创建成员专属的确定性 Workspace 目录，再接纳 Peer。Workspace 变化会使 Remote 快照失效，新会话只会出现在所属成员的列表中。退出及过期会撤销成员 Peer 和流。存储失败返回脱敏错误；持久化撤销失败时，必须修复存储后再重启。

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 认证

#### 模型看到的内容

认证层不会把成员身份或登录数据加入模型上下文；`wecom-user` 只用于 Remote 访问控制。

#### Token 影响

认证层不会添加模型请求内容，也不会增加 token 使用量。

#### KV Cache 影响

认证层不会改变模型请求缓存。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 登录时验证可见范围；应用可见范围变更在下次登录或本地会话过期时生效，默认八小时。
- 此层不会授予 Owner 权限；在成员专属 Workspace 外创建的既有 Workspace 和会话对该成员不可见。
- 认证挂载于公网 origin 根路径；不支持子路径部署。
- 官方二维码 SDK 要求浏览器可访问企业微信 CDN 和面板域名。API 访问要求应用具有目录和标签权限；权限不足会拒绝登录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
