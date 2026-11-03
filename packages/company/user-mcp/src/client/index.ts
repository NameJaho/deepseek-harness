/** Browser composition: the member's default-Agent MCP selection in the right sidebar. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconCordisPluginOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import remote from '@deepseek-ai/dsh-company-user-mcp/remote'
import { en, zh, type UserMcpLocaleKey } from './locales.ts'
import { UserMcpPanel } from './panel.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Member MCP selection for the default Agent. */
    'company.userMcp': UserMcpLocaleKey
  }
}

/** Shell services used by the sidebar registration. */
export const inject = ['slots', 'locale', 'remote', 'sidebarRight', 'sidebarRightTabs']

/** Mount the Remote namespace and register the sidebar tab once the shell services are ready.
 * @param ctx - browser plugin lifecycle.
 * @returns teardown that releases the tab and the Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote)
  ctx.effect(() => ctx.locale.register('company.userMcp', { zh, en }), 'company-user-mcp: dictionaries')
  const ui = ctx.inject(['remote.companyUserMcp', 'slots', 'locale', 'sidebarRight', 'sidebarRightTabs'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await unmount(); throw error }
  return async () => { await ui.dispose(); await unmount() }
}

/** Register the sidebar tab and its pane; Remote failures surface as rejected promises to the panel.
 * @param ctx - connected shell services.
 */
function registerUi(ctx: Context): void {
  const t = ctx.locale.bind('company.userMcp')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'user-mcp-capabilities', kind: 'user-mcp-capabilities',
    title: () => t('tab'), guide: [{ id: 'user-mcp-capabilities', order: 17, title: () => t('tab'),
      description: () => t('guide'), icon: IconCordisPluginOutlineRegular }],
  }), 'company-user-mcp: sidebar tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'user-mcp-capabilities',
    locale: 'company.userMcp', inject: () => ({
      load: async () => {
        const result = await ctx.remote.companyUserMcp.preferences()
        if (!result.ok) throw result.error
        return result.value
      },
      save: async (selectedIds: readonly string[]) => {
        const result = await ctx.remote.companyUserMcp.setPreferences({ selectedIds: [...selectedIds] })
        if (!result.ok) throw result.error
        return result.value
      },
    }),
  }, UserMcpPanel))
}
