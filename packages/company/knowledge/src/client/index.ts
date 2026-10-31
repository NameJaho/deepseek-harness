/** Knowledge management contribution on the existing Plugins page. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import remote from '@deepseek-ai/dsh-company-knowledge/remote'
import { KnowledgeController } from './controller.ts'
import { KnowledgePage } from './page.tsx'
import { en, zh, type KnowledgeLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'company.knowledge': KnowledgeLocaleKey } }

/** Services required by knowledge management. */
export const inject = ['remoteAccess', 'slots', 'locale', 'remote']

/** Mount retrieval management and drain its work before removing the Remote namespace.
 * @param ctx - browser plugin lifecycle.
 * @returns ordered UI and Remote teardown.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote)
  const ui = ctx.inject(['remote.companyKnowledge', 'remoteAccess', 'slots', 'locale'], (child) => {
    child.effect(() => child.locale.register('company.knowledge', { en, zh }), 'company-knowledge: dictionaries')
    const controller = new KnowledgeController(child.remote.companyKnowledge)
    const face = controller.face()
    const t = child.locale.bind('company.knowledge')
    child.effect(() => { const ready = face.refreshKnowledge(); return async () => { await controller.dispose(); await ready } },
      'company-knowledge: management requests')
    child.remoteAccess.whenAccess('companyKnowledge/catalog', () => {
      return child.slots.inject('plugins.item', () => child.slots.register({ name: 'plugins.item', id: 'company-knowledge',
        order: 26, locale: 'company.knowledge', label: () => t('title'), inject: () => face }, KnowledgePage))
    })
  })
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}
