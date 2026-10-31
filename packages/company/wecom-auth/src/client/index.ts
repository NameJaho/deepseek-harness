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
  interface LocaleNamespaceMap { 'company.wecomAuth': 'account' | 'admin' | 'user' }
}

/** Services used for account navigation and reconnection. */
export const inject = ['connection', 'slots', 'locale']

const browserIdentity = z.object({ userId: z.string(), displayName: z.string().optional(), role: z.enum(['admin', 'user']).default('user') })
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
  ctx.effect(() => ctx.locale.register('company.wecomAuth', { en: { account: 'WeCom account', admin: 'Administrator', user: 'Standard user' }, zh: { account: '企业微信账号', admin: '管理员', user: '普通用户' } }))
  const loginUrl = (account: boolean): URL => {
    const url = new URL('login', document.baseURI)
    url.searchParams.set('redirect', location.pathname + location.search)
    if (account) url.searchParams.set('account', '1')
    return url
  }
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'wecom-account',
    locale: 'company.wecomAuth', inject: () => ({ displayName: identity.displayName ?? identity.userId, roleLabel: identity.role === 'admin' ? ctx.locale.bind('company.wecomAuth')('admin') : ctx.locale.bind('company.wecomAuth')('user'),
      openAccount: () => { location.assign(loginUrl(true)) } }),
  }, WecomAccount))
  ctx.effect(() => {
    const lifetime = new AbortController()
    let checking: Promise<void> | undefined
    const check = (): void => {
      if (connection.state.getSnapshot() === 'connected' || checking !== undefined) return
      checking = (async () => {
        try {
          const response = await fetch(new URL('auth/me', document.baseURI), { credentials: 'same-origin', signal: lifetime.signal })
          if (response.status === 401 && !lifetime.signal.aborted) location.replace(loginUrl(false))
        } catch (_networkUnavailable) {
          // Connection owns network recovery; only a confirmed 401 replaces this browser's page.
        } finally { checking = undefined }
      })()
    }
    const dispose = connection.state.subscribe(check)
    return async () => { lifetime.abort(); dispose(); await checking }
  }, 'wecom-auth: browser session recovery')
}
