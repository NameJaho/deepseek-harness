/** Generated Remote mount, publication cards and robot management registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-company-cloud-agent/client'
import remote from '@deepseek-ai/dsh-company-wecom/remote'
import { WecomController } from './controller.ts'
import { en, zh, type WecomLocaleKey } from './locales.ts'
import { WecomAgentChannel, WecomPage, WecomToast } from './views.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Company robot authorization and connection state. */
    'company.wecom': WecomLocaleKey
  }
}

/** Existing shell registration, localization and generated RPC services. */
export const inject = ['slots', 'locale', 'remote']

/** Mount all UI consumers before starting the snapshot stream.
 * @param ctx - browser plugin lifecycle.
 * @returns teardown that drains consumers before releasing the Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote)
  const child = ctx.inject(['remote.companyWecom', 'slots', 'locale'], (ui) => {
    ui.effect(() => ui.locale.register('company.wecom', { en, zh }), 'wecom: dictionaries')
    const controller = new WecomController(ui.remote.companyWecom, () => ui.remote.$stream({
      name: 'company-wecom.snapshot', open: signal => ui.remote.companyWecom.follow(signal),
      ended: () => new Error('WeCom snapshot stream ended'),
    }))
    const face = controller.face()
    ui.slots.inject('plugins.item', () => ui.slots.register({
      name: 'plugins.item', id: 'company-wecom', order: 26, locale: 'company.wecom',
      label: () => ui.locale.bind('company.wecom')('title'), inject: () => face,
    }, WecomPage))
    ui.slots.inject('company.cloudAgent.page.release.actions', () => ui.slots.register({
      name: 'company.cloudAgent.page.release.actions', id: 'wecom', locale: 'company.wecom', inject: () => face,
    }, WecomAgentChannel))
    ui.slots.inject('shell.overlay', () => ui.slots.register({
      name: 'shell.overlay', id: 'company-wecom.toast', locale: 'company.wecom', inject: () => face,
    }, WecomToast))
    ui.effect(() => { controller.start(); return () => controller.dispose() }, 'wecom: browser authorization lifecycle')
  })
  try { await child } catch (error) { await child.dispose(); await unmount(); throw error }
  return async () => { await child.dispose(); await unmount() }
}
