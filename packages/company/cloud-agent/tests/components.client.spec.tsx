// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudAgentCatalog, CloudAgentRecord, CloudAgentRelease } from '../src/types.ts'
import type { CloudAgentView } from '../src/client/controller.ts'
import type { McpView } from '../src/client/mcp-controller.ts'
import type { CompanyMcpId, CompanyMcpServer } from '../src/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import { CompanyMcpPage, ToolDisclosure } from '../src/client/mcp-page.tsx'
import { CapabilityChoices, CloudAgentCapabilitiesPanel } from '../src/client/capabilities.tsx'
import { CloudAgentInfo, CloudAgentInfoNavigation } from '../src/client/info.tsx'
import { CloudAgentPage } from '../src/client/page.tsx'
import { en, zh, type CloudAgentLocaleKey } from '../src/client/locales.ts'
import type {} from '../src/client/index.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const translate = (dict: Record<CloudAgentLocaleKey, string>): ComponentProps<typeof CompanyMcpPage>['t'] =>
  ((key: CloudAgentLocaleKey, params?: Record<string, string>) => Object.entries(params ?? {}).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), dict[key])) as ComponentProps<typeof CompanyMcpPage>['t']
const t = translate(en)
const server: CompanyMcpServer = { id: 'search-service' as CompanyMcpId, name: 'Research service', description: 'Search company documents', enabled: true, status: 'available', updatedAt: 1,
  tools: [{ name: 'research.search', rawName: 'search', description: 'Look up payroll policies', fingerprint: 'fingerprint',
    parametersJson: JSON.stringify({ type: 'object', properties: { query: { type: 'string', description: 'Search terms' }, limit: { type: 'integer' } }, required: ['query'] }) }] }
const maintenance: CompanyMcpServer = { ...server, id: 'maintenance' as CompanyMcpId, name: 'Maintenance service', description: 'Temporarily unavailable', status: 'maintenance', tools: [] }
function mcpProps(view: McpView): ComponentProps<typeof CompanyMcpPage> {
  return { t, view: 'page', useCompanyMcp: <T,>(select: (value: McpView) => T): T => select(view),
    refreshMcp: vi.fn(async () => {}), retryMcp: vi.fn(async () => {}),
    discoverMcp: vi.fn(async () => {}) } as ComponentProps<typeof CompanyMcpPage>
}
const record: CloudAgentRecord = { id: 'agent' as CloudAgentRecord['id'], ownerId: 'owner' as CloudAgentRecord['ownerId'], revision: 1,
  draft: { name: 'Draft name', description: 'Draft description', instructions: 'Research', provider: 'p', model: 'm', mcpTools: [], skills: [] },
  releases: [], publishedReleaseId: null, createdAt: 1, updatedAt: 1 }
const release: CloudAgentRelease = { id: 'pinned-release' as CloudAgentRelease['id'], kind: 'published', version: 4, draftRevision: 1, createdAt: 1,
  definition: { ...record.draft, name: 'Pinned Agent', mcpTools: ['saved.missing'], mcpServers: [server.id], skills: ['saved.skill'] },
  mcpBindings: [{ name: 'saved.missing', fingerprint: 'saved' }], visibility: 'private', digest: 'release-digest', source: { sessionId: 'source' as SessionId, throughSeq: 7, preset: 'creation-mode' },
  skillSnapshots: [{ name: 'saved.skill', description: 'Pinned skill description', content: 'Pinned content', resources: [] }] }
const sessionId = 'usage' as SessionId
const catalog: CloudAgentCatalog = { mine: [{ ...record, releases: [release], publishedReleaseId: release.id }], published: [],
  conversations: [{ agentId: record.id, role: 'usage', sessionId, releaseId: release.id, creationPreset: 'creation-mode', runPreset: 'run-mode', effectiveDigest: 'effective-digest' }],
  usage: [{ agentId: record.id, ownerId: record.ownerId, name: 'Stable Agent', status: 'disabled', release }],
  models: { groups: [], default: { provider: 'p', model: 'm' }, routableProviders: [], failures: [] }, capabilities: { mcpTools: [{ name: 'unselected.global', description: 'Global tool' }], skills: [{ name: 'global.skill', description: 'Global skill' }], mcpServers: [] } }
type ProjectionKey = Extract<keyof SessionProjectionMap, string>
function useProjection<K extends ProjectionKey>(key: K): SessionProjectionMap[K] | undefined
function useProjection<K extends ProjectionKey, S>(key: K, selector: (value: SessionProjectionMap[K] | undefined) => S): S
function useProjection(key: ProjectionKey, selector?: (value: SessionProjectionMap[ProjectionKey] | undefined) => unknown): unknown {
  const values: Partial<SessionProjectionMap> = { agentPreset: 'workspace-write',
    modelSelection: { lastUsed: { provider: 'runtime-provider', model: 'runtime-model' }, next: null } }
  return selector === undefined ? values[key] : selector(values[key])
}
const viewOf = (catalog: CloudAgentCatalog): CloudAgentView => ({
  catalog, presets: [], busy: false, loading: false, error: null, notice: null, editorRequest: null,
})
function agentProps(view: CloudAgentView) {
  return { t, sessionId, useCloudAgent: <T,>(select: (value: CloudAgentView) => T): T => select(view), useProjection,
    refresh: vi.fn(async () => {}), prepareEditor: vi.fn(async () => 'controlled-editor' as SessionId), openConversation: vi.fn(), clone: vi.fn(async () => {}),
    saveCapabilities: vi.fn(async () => undefined), manageMcp: vi.fn() }
}

describe.each([{ name: 'English', dict: en }, { name: 'Chinese', dict: zh }])('$name MCP presentation', ({ dict }) => {
  it('searches server and tool names/descriptions, filters status, and expresses status with text', () => {
    const props = {
      ...mcpProps({ catalog: { loaded: true, servers: [server, maintenance] }, busy: false, loading: false, error: false }),
      t: translate(dict),
    }
    render(<CompanyMcpPage {...props} />)
    expect(screen.getByRole('heading', { name: server.name })).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBe(null)
    const search = screen.getByRole('textbox', { name: dict.mcpSearch })
    for (const term of ['Research', 'company documents', 'research.search', 'payroll policies']) {
      fireEvent.change(search, { target: { value: term } })
      expect(screen.getByRole('heading', { name: server.name })).toBeTruthy()
      expect(screen.queryByRole('heading', { name: maintenance.name })).toBe(null)
    }
    fireEvent.change(search, { target: { value: '' } })
    fireEvent.change(screen.getByRole('combobox', { name: dict.mcpFilter }), { target: { value: 'maintenance' } })
    expect(screen.queryByRole('heading', { name: server.name })).toBe(null)
    expect(screen.getByRole('heading', { name: maintenance.name })).toBeTruthy()
    expect(screen.getAllByText(dict.mcpMaintenance).length).toBeGreaterThan(0)
  })

  it('keeps tool details collapsed and presents parameters before copyable JSON Schema', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const { container } = render(<ToolDisclosure tool={server.tools[0]!} t={translate(dict)} />)
    const disclosure = container.querySelector('details')!
    expect(disclosure.open).toBe(false)
    fireEvent.click(container.querySelector('summary')!)
    expect(disclosure.open).toBe(true)
    const table = screen.getByRole('table')
    expect(within(table).getByText('query')).toBeTruthy()
    expect(within(table).getByText(dict.mcpRequired)).toBeTruthy()
    expect(within(table).getByText(dict.mcpOptional)).toBeTruthy()
    fireEvent.click(screen.getByText(dict.mcpFullSchema))
    const copy = screen.getByRole('button', { name: dict.mcpCopy })
    expect(table.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(copy)
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith(JSON.stringify(JSON.parse(server.tools[0]!.parametersJson), null, 2)) })
  })
})

describe('MCP failure and pending presentation', () => {
  it('retains cards on failure, offers retry, and disables duplicate management submissions', () => {
    const props = mcpProps({ catalog: { loaded: true, servers: [server] }, busy: false, loading: false, error: true })
    const { rerender } = render(<CompanyMcpPage {...props} />)
    expect(screen.getByRole('heading', { name: server.name })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain(en.mcpFailed)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(props.retryMcp).toHaveBeenCalledOnce()
    rerender(<CompanyMcpPage {...mcpProps({ catalog: { loaded: true, servers: [server] }, busy: true, loading: false, error: false })} />)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.mcpRefresh }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.mcpInspect }).disabled).toBe(true)
  })

  it('distinguishes a loading catalog from empty results', () => {
    const { rerender } = render(<CompanyMcpPage {...mcpProps({ catalog: null, busy: false, loading: true, error: false })} />)
    expect(screen.getByRole('status', { name: en.loading })).toBeTruthy()
    rerender(<CompanyMcpPage {...mcpProps({ catalog: { loaded: true, servers: [] }, busy: false, loading: false, error: false })} />)
    expect(screen.getByText(en.mcpEmpty)).toBeTruthy()
  })
})

describe('scoped Agent capabilities and information', () => {
  it('shows only pinned MCP and skill selections and enters controlled editing without editing the usage Session', async () => {
    const props = agentProps(viewOf(catalog))
    render(<CloudAgentCapabilitiesPanel {...props as ComponentProps<typeof CloudAgentCapabilitiesPanel>} />)
    expect(screen.getByText('saved.missing')).toBeTruthy()
    expect(screen.getByText('saved.skill')).toBeTruthy()
    expect(screen.queryByText('unselected.global')).toBe(null)
    expect(screen.queryByText('global.skill')).toBe(null)
    expect(screen.queryByRole('checkbox')).toBe(null)
    fireEvent.click(screen.getByRole('button', { name: en.editAgent }))
    await waitFor(() => { expect(props.prepareEditor).toHaveBeenCalledWith(record.id) })
    await waitFor(() => { expect(props.openConversation).toHaveBeenCalledWith('controlled-editor') })
    expect(props.saveCapabilities).not.toHaveBeenCalled()
  })

  it('clones foreign releases rather than opening an owned editor', async () => {
    const foreign = { ...catalog, mine: [], published: [{ id: record.id, ownerId: record.ownerId, release }] }
    const props = agentProps(viewOf(foreign))
    render(<CloudAgentCapabilitiesPanel {...props as ComponentProps<typeof CloudAgentCapabilitiesPanel>} />)
    fireEvent.click(screen.getByRole('button', { name: en.clone }))
    await waitFor(() => { expect(props.clone).toHaveBeenCalledWith(record.id, release.id) })
    expect(props.prepareEditor).not.toHaveBeenCalled()
  })

  it('retains unsaved choices when a newer revision arrives until explicitly reloaded', () => {
    const editable = { ...catalog, conversations: [{ sessionId, agentId: record.id, role: 'authoring' as const }], mine: [record] }
    const props = agentProps(viewOf(editable))
    const { rerender } = render(<CloudAgentCapabilitiesPanel {...props as ComponentProps<typeof CloudAgentCapabilitiesPanel>} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'global.skill' }))
    const newer = { ...editable, mine: [{ ...record, revision: 2 }] }
    rerender(<CloudAgentCapabilitiesPanel {...agentProps(viewOf(newer)) as ComponentProps<typeof CloudAgentCapabilitiesPanel>} />)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'global.skill' }).checked).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: en.capabilitySave }).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain(en.conflict)
    fireEvent.click(screen.getByRole('button', { name: en.reloadDraft }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'global.skill' }).checked).toBe(false)
  })

  it('retains failed capability edits and retries exactly the same revision and selections', async () => {
    const editable = { ...catalog, conversations: [{ sessionId, agentId: record.id, role: 'authoring' as const }], mine: [record] }
    const props = agentProps(viewOf(editable))
    render(<CloudAgentCapabilitiesPanel {...props as ComponentProps<typeof CloudAgentCapabilitiesPanel>} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'global.skill' }))
    fireEvent.click(screen.getByRole('button', { name: en.capabilitySave }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.retry })).toBeTruthy() })
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'global.skill' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    await waitFor(() => { expect(props.saveCapabilities).toHaveBeenCalledTimes(2) })
    expect(props.saveCapabilities.mock.calls[0]).toEqual(props.saveCapabilities.mock.calls[1])
  })

  it('shows selected server and deduplicated tool counts, retaining names absent from the catalog', () => {
    render(<CapabilityChoices catalog={{ ...catalog.capabilities, mcpServers: [{ id: server.id, name: server.name, namespace: 'research', description: server.description,
      enabled: true, status: 'available', toolNames: ['research.search'] }] }} selection={{ mcpServers: [server.id], mcpTools: ['research.search', 'saved.missing'], skills: ['saved.skill'] }} busy={false} t={t} onChange={vi.fn()} />)
    expect(screen.getByText('1 services selected · 2 tools selected')).toBeTruthy()
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: server.name }).checked).toBe(true)
    fireEvent.click(screen.getByText(en.mcpTools))
    expect(screen.getByRole('checkbox', { name: 'saved.missing' })).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'saved.skill' })).toBeTruthy()
  })

  it('shows owner, version, creation/run presets, actual model, availability and digests', () => {
    const { t, sessionId, useCloudAgent, refresh, openConversation } = agentProps(viewOf(catalog))
    const props = { t, sessionId, useCloudAgent, useProjection, refresh, openConversation }
    render(<CloudAgentInfo {...props as ComponentProps<typeof CloudAgentInfo>} />)
    for (const label of ['owner', 'Version 4', 'creation-mode', 'run-mode', 'runtime-provider', 'runtime-model', en.statusDisabled, 'release-digest', 'effective-digest']) expect(screen.getByText(label)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.sourceSession }))
    expect(props.openConversation).toHaveBeenCalledWith('source')
  })

  it('never opens the sidebar automatically and reveals information only for its current Session on click', () => {
    const revealAgentInfo = vi.fn()
    const { t, sessionId, useCloudAgent, refresh } = agentProps(viewOf(catalog))
    const props = { t, sessionId, useCloudAgent, useProjection, refresh }
    render(<CloudAgentInfoNavigation {...props as ComponentProps<typeof CloudAgentInfoNavigation>} revealAgentInfo={revealAgentInfo} />)
    expect(revealAgentInfo).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.agentInfo }))
    expect(revealAgentInfo).toHaveBeenCalledWith(sessionId)
  })
})

describe('publication form', () => {
  it('confirms name, description and audience and retains the dialog on failed publication', async () => {
    const { sessionId: _sessionId, useProjection: _useProjection, manageMcp: _manageMcp, ...shared } =
      agentProps(viewOf({ ...catalog, mine: [record] }))
    const props = { ...shared, renderSlot: () => null, createInChat: vi.fn(), preview: vi.fn(), unpublish: vi.fn(),
      deleteAgent: vi.fn(), closeEditor: vi.fn(),
      save: vi.fn(), publish: vi.fn(async () => false), start: vi.fn(), manage: vi.fn(), fromConversation: vi.fn(), dismissNotice: vi.fn() }
    render(<CloudAgentPage {...props as ComponentProps<typeof CloudAgentPage>} />)
    fireEvent.click(screen.getByText(en.mine))
    fireEvent.click(screen.getByRole('button', { name: en.publish }))
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText(record.draft.name)).toBeTruthy()
    expect(within(dialog).getByText(record.draft.description)).toBeTruthy()
    fireEvent.change(within(dialog).getByRole('combobox', { name: en.visibility }), { target: { value: 'private' } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.publish }))
    await waitFor(() => { expect(props.publish).toHaveBeenCalledWith(record, undefined, 'private') })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
