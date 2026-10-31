# Agent Note: 可信网关用户身份桥接

Status: implemented

[English](2026-10-31-gateway-user-identity-bridge.md) | 中文

## 问题

部分公司部署在上游门户完成用户认证，而不是使用 DSH 的企微 OAuth 页面。门户约定提供包含 `userId` 和 `userName` 的 URL 编码 `X-User-Info` JSON，但不会提供 DSH 会话 Cookie 或登录 API。因此 DSH 无法显示门户用户名称，也没有门户退出地址。

## 决策

WeCom 认证包保留本地 OAuth 流程，并增加可选的网关身份模式。启用后，Host 只把 `X-User-Info` 当作可信反向代理断言，校验 `userId` 和 `userName`，创建确定性的私有 Workspace 身份，并应用与成员相同的 Remote 权限策略。浏览器通过现有 `__DSH_WECOM_SESSION__` 注入和 `/auth/me` 响应获得已校验的姓名。

网关会话不会创建本地 Cookie。账号页面在配置 `gatewayLogoutUrl` 时跳转到门户退出地址；本地 WeCom 会话继续使用 `/auth/wecom/logout`。该模式默认关闭，只有在公共监听地址由会清除客户端身份 header 的代理保护时才能启用。

## 考虑过的替代方案

**用门户约定替换 WeCom OAuth。** 该约定只说明身份注入，没有登录、Token 签发或退出接口。替换 OAuth 会让直接部署失去认证，并使 DSH 依赖未定义的网关行为。

**在所有部署中信任 `X-User-Info`。** 直接访问 DSH 的浏览器可以伪造普通 HTTP header。因此该模式由部署显式开启，且要求代理成为访问监听器的唯一入口。

**只显示 header 而不应用 Workspace 权限。** 这样虽然能显示姓名，但授权仍会落到 Owner 或其他会话。网关身份也使用与本地成员相同的逐用户 Workspace 和 Remote 限制。

## 后果

由于 Workspace 持久化是异步的，网关身份首次加载期间可能需要客户端按现有机制重试。网关退出仍由门户负责，必须显式配置 URL。`X-Operate-Info` 权限上下文不会被当作身份。默认 WeCom OAuth 和本地退出行为保持不变。
