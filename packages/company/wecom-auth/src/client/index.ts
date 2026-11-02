/** Enterprise account navigation and recovery after authenticated Connection loss. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { z } from 'zod'
import { WecomAccount } from './account.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'company.wecomAuth': 'account' | 'admin' | 'user' | 'name' | 'userId' | 'corpId' | 'role' | 'logout' | 'failed' }
}

/** Services used for account navigation and reconnection. */
export const inject = ['connection', 'slots', 'locale']

const browserIdentity = z.object({ userId: z.string(), corpId: z.string().default(''), displayName: z.string().optional(),
  role: z.enum(['admin', 'user']).default('user'), logoutUrl: z.string().optional() })
type BrowserIdentity = z.infer<typeof browserIdentity>

/** Install account controls for the page's enterprise identity: the index injection, otherwise `/auth/me`.
 * @param ctx - browser plugin context; unload cancels identity and recovery requests and subscriptions.
 */
export function apply(ctx: Context): void {
  const injected = browserIdentity.safeParse(Reflect.get(globalThis, '__DSH_WECOM_SESSION__'))
  if (injected.success) {
    install(ctx, injected.data)
    return
  }
  // The index may be rendered for the Owner's shared browser Peer, so a member page can lack the injection.
  ctx.effect(() => {
    const lifetime = new AbortController()
    const loading = (async () => {
      try {
        const response = await fetch(new URL('auth/me', document.baseURI), { credentials: 'same-origin', signal: lifetime.signal })
        if (!response.ok) {
          console.warn(`[wecom-auth] /auth/me answered ${response.status}; account controls are hidden`)
          return
        }
        const parsed = z.object({ session: browserIdentity }).safeParse(await response.json())
        if (!parsed.success) {
          console.warn('[wecom-auth] /auth/me returned no valid identity; account controls are hidden')
          return
        }
        if (!lifetime.signal.aborted) install(ctx, parsed.data.session)
      } catch (error) {
        if (!lifetime.signal.aborted) console.warn('[wecom-auth] reading /auth/me failed; account controls are hidden', error)
      }
    })()
    return async () => { lifetime.abort(); await loading }
  }, 'wecom-auth: account identity')
}

function install(ctx: Context, identity: BrowserIdentity): void {
  console.info('[wecom-auth] browser identity', identity)
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(() => ctx.locale.register('company.wecomAuth', {
    en: { account: 'WeCom account', admin: 'Administrator', user: 'Standard user', name: 'Name', userId: 'User ID', corpId: 'Corporation ID', role: 'Role', logout: 'Sign out', failed: 'Sign-out failed. Try again.' },
    zh: { account: '企业微信账号', admin: '管理员', user: '普通用户', name: '姓名', userId: '用户 ID', corpId: '企业 ID', role: '角色', logout: '退出登录', failed: '退出失败，请重试。' },
  }))
  const loginUrl = (): URL => {
    const url = new URL('login', document.baseURI)
    url.searchParams.set('redirect', location.pathname + location.search)
    return url
  }
  const signOut = async (): Promise<void> => {
    if (identity.logoutUrl !== undefined) { location.assign(identity.logoutUrl); return }
    // The HttpOnly session cookie is cleared only by the server response.
    const response = await fetch(new URL('auth/wecom/logout', document.baseURI), {
      method: 'POST', credentials: 'same-origin', headers: { 'x-dsh-auth': '1' } })
    if (!response.ok) throw new Error(`wecom-auth: sign-out answered ${response.status}`)
    location.replace(new URL('login', document.baseURI))
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'wecom-account',
    locale: 'company.wecomAuth', inject: () => ({ displayName: identity.displayName ?? identity.userId, userId: identity.userId, corpId: identity.corpId, signOut, roleLabel: identity.role === 'admin' ? ctx.locale.bind('company.wecomAuth')('admin') : ctx.locale.bind('company.wecomAuth')('user') }),
  }, WecomAccount))
  ctx.effect(() => {
    const lifetime = new AbortController()
    let checking: Promise<void> | undefined
    const check = (): void => {
      if (connection.state.getSnapshot() === 'connected' || checking !== undefined) return
      checking = (async () => {
        try {
          const response = await fetch(new URL('auth/me', document.baseURI), { credentials: 'same-origin', signal: lifetime.signal })
          if (response.status === 401 && !lifetime.signal.aborted) location.replace(loginUrl())
        } catch (_networkUnavailable) {
          // Connection owns network recovery; only a confirmed 401 replaces this browser's page.
        } finally { checking = undefined }
      })()
    }
    const dispose = connection.state.subscribe(check)
    return async () => { lifetime.abort(); dispose(); await checking }
  }, 'wecom-auth: browser session recovery')
}
