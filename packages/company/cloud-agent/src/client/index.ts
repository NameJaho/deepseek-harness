/** Phase 2 Agent UI, sanitized MCP management and caller-scoped navigation assembly. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-company-user-mcp/remote'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { IconCordisPluginOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import remote from '@deepseek-ai/dsh-company-cloud-agent/remote'
import mcpRemote from '@deepseek-ai/dsh-company-mcp-provider/remote'
import { CloudAgentController } from './controller.ts'
import { AgentNavigationGroups, AgentNavigationGroupsGate } from './navigation.ts'
import { CloudAgentIcon, CloudAgentPage, CloudAgentToast } from './page.tsx'
import { en, zh, type CloudAgentLocaleKey } from './locales.ts'
import { CloudAgentDraftCard, CloudAgentHeaderAction } from './conversation.tsx'
import { McpController } from './mcp-controller.ts'
import { CompanyMcpPage } from './mcp-page.tsx'
import { CloudAgentReportCard } from './report.tsx'
import { CapabilitiesBody, CapabilitiesTitle, CloudAgentCapabilitiesNavigation, type UserMcpInjected } from './capabilities.tsx'
import './page-slots.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Agent authoring, immutable releases and sanitized company MCP management. */
    'company.cloudAgent': CloudAgentLocaleKey
  }
}

/** Transport readiness and existing shell extension services. */
export const inject = ['slots', 'locale', 'remote', 'connection', 'uiWorkspace', 'layout', 'sidebarRight', 'sidebarRightTabs', 'pluginNavigation']

function registerUi(ctx: Context, navigation: AgentNavigationGroupsGate): void {
  const id = 'company-cloud-agent' as MainPanelId
  const t = ctx.locale.bind('company.cloudAgent')
  const controller = new CloudAgentController(ctx.remote.cloudAgents, () => ctx.remote.$stream({
    name: 'cloud-agent.catalog', open: signal => ctx.remote.cloudAgents.follow(signal),
    ended: () => new Error('Cloud Agent catalog stream ended'),
  }), (session) => {
    void (async () => {
      const id = session.sessionId
      if (ctx.sessions.list.getSnapshot().byId[id] === undefined) await ctx.sessions.refresh()
      if (ctx.sessions.list.getSnapshot().byId[id] === undefined) throw new Error(`Created Session is not visible: ${id}`)
      ctx.uiWorkspace.openSession(id)
    })().catch((error: unknown) => { console.error('Cloud Agent Session navigation failed', error) })
  }, () => { ctx.uiWorkspace.startSession() }, async (sessionId) => {
    const result = await ctx.remote.commands.execute(sessionId, '/创建智能体', [])
    if (!result.ok) throw result.error
    return result.value?.result.kind === 'success'
  }, () => { ctx.layout.selectPanel(id) }, async () => {
    const result = await ctx.remote.agentPresets.list()
    if (!result.ok) throw result.error
    return result.value.presets.map(({ id, name, broken }) => ({ id,
      ...name === undefined ? {} : { name }, ...broken === undefined ? {} : { broken } }))
  })
  ctx.effect(() => { void controller.refresh(); return () => controller.dispose() }, 'cloud-agent: catalog lifecycle')
  const face = controller.face()
  ctx.effect(() => {
    const groups = new AgentNavigationGroups(controller, controller.startGroupedSession)
    navigation.set(groups)
    return () => { navigation.set(undefined); groups.dispose() }
  }, 'cloud-agent: caller navigation groups')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: 'cloud-agent-capabilities', kind: 'cloud-agent-capabilities',
    title: () => t('capabilitiesMenu'), guide: [{ id: 'cloud-agent-capabilities', order: 16, title: () => t('capabilitiesMenu'),
      description: () => t('capabilitiesGuide'), icon: IconCordisPluginOutlineRegular }],
  }), 'cloud-agent: capabilities tab')
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'cloud-agent-capabilities',
    locale: 'company.cloudAgent', inject: () => ({ hooks: face.hooks, refresh: face.refresh,
      saveCapabilities: face.saveCapabilities, prepareEditor: face.prepareEditor, openConversation: face.openConversation,
      clone: face.clone,
      manageMcp: () => { ctx.pluginNavigation.openItem('company-mcp') },
      userMcp: userMcpInjected(ctx),
    }),
  }, CapabilitiesBody))
  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: 'cloud-agent-capabilities', locale: 'company.cloudAgent',
    inject: () => ({ hooks: face.hooks }),
  }, CapabilitiesTitle))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'cloud-agent-capabilities', locale: 'company.cloudAgent',
    inject: () => ({ hooks: face.hooks, refresh: face.refresh,
      revealCapabilities: (sessionId: SessionId) => { ctx.sidebarRight.openTabIn(sessionId, 'cloud-agent-capabilities') } }),
  }, CloudAgentCapabilitiesNavigation))
  const mcp = new McpController(ctx.remote.companyMcp, () => ctx.remote.$stream({ name: 'company-mcp.catalog',
    open: signal => ctx.remote.companyMcp.follow(signal), ended: () => new Error('Company MCP stream ended'),
  }), controller.reportNotice)
  ctx.effect(() => { mcp.start(); return () => mcp.dispose() }, 'company-mcp: management lifecycle')
  const mcpFace = mcp.face()
  ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'company-mcp', order: 25, locale: 'company.cloudAgent', label: () => t('mcpTitle'), inject: () => mcpFace,
  }, CompanyMcpPage))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: id, locale: 'company.cloudAgent', inject: () => face,
    children: {
      'company.cloudAgent.page.actions': { kind: 'list', scope: 'root' },
      'company.cloudAgent.page.release.actions': { kind: 'list', scope: 'root' },
    },
  }, CloudAgentPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id, order: 5, locale: 'company.cloudAgent', label: () => t('panel'),
  }, CloudAgentIcon))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'cloud-agent.notice', locale: 'company.cloudAgent',
    inject: () => ({ hooks: face.hooks, dismissNotice: face.dismissNotice }),
  }, CloudAgentToast))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions', id: 'cloud-agent-create', order: 10, locale: 'company.cloudAgent',
    inject: () => ({ hooks: face.hooks, refresh: face.refresh, prepareEditor: face.prepareEditor, openConversation: face.openConversation,
      clone: face.clone, fromConversation: face.fromConversation, manage: face.manage }),
  }, CloudAgentHeaderAction))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'cloud_report', locale: 'company.cloudAgent',
  }, CloudAgentReportCard))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'cloud_agent', locale: 'company.cloudAgent',
    inject: () => ({ hooks: face.hooks, preview: face.preview, manage: face.manage }),
    children: { 'company.cloudAgent.draft.actions': { kind: 'list', scope: 'session' } },
  }, CloudAgentDraftCard))
}

/** Scope private catalogs and editor state to one authenticated transport generation. */
function registerConnectedUi(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const navigation = new AgentNavigationGroupsGate()
  const unregister = ctx.uiWorkspace.registerGroups(navigation)
  const registerCurrentUi = (uiCtx: Context): void => { registerUi(uiCtx, navigation) }
  let ui: ReturnType<Context['plugin']> | undefined
  let pending = Promise.resolve()
  let revision = 0
  let stopped = false
  const changed = (): void => {
    const current = ++revision
    const previous = ui
    ui = undefined
    navigation.set(undefined)
    const draining = previous?.dispose()
    pending = Promise.all([pending, draining]).then(() => {
      if (!stopped && current === revision && connection.generation.getSnapshot() !== undefined) {
        ui = ctx.plugin(registerCurrentUi)
      }
    })
  }
  ctx.effect(() => connection.generation.subscribe(changed), 'cloud-agent: connection generation')
  ctx.effect(() => async () => {
    stopped = true
    revision++
    await ui?.dispose()
    await pending
    unregister()
    navigation.dispose()
  }, 'cloud-agent: private UI lifecycle')
  changed()
}

/** Mount generated browser-safe methods; drain consumers before unmounting namespaces.
 * @param ctx - browser services owned by the plugin lifecycle.
 * @returns ordered UI and Remote teardown.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(remote)
  let unmountMcp: (() => Promise<void>) | undefined
  try { unmountMcp = await ctx.remote.$mount(mcpRemote) } catch (error) { await unmountRemote(); throw error }
  ctx.effect(() => ctx.locale.register('company.cloudAgent', { zh, en }), 'cloud-agent: dictionaries')
  const ui = ctx.inject(['remote.cloudAgents', 'remote.companyMcp', 'remote.commands', 'remote.agentPresets', 'connection', 'sessions',
    'slots', 'locale', 'uiWorkspace', 'layout', 'sidebarRight', 'sidebarRightTabs', 'pluginNavigation', 'remote.companyUserMcp'], registerConnectedUi)
  try { await ui } catch (error) { await ui.dispose(); await unmountMcp(); await unmountRemote(); throw error }
  return async () => { await ui.dispose(); await unmountMcp(); await unmountRemote() }
}

/** Default-Agent selection callbacks for the capabilities pane; failed Remote results throw to the panel.
 * @param ctx - connected shell services with the user MCP Remote.
 * @returns the translation and the read and write functions.
 */
function userMcpInjected(ctx: Context): UserMcpInjected {
  return {
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
  }
}
