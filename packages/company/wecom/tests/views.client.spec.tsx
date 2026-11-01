// @vitest-environment jsdom
/** Recorded result presentation, live authorization states and shell-owned feedback. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { GlobalStandardProps, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'
import type { CloudAgentRecord, CloudAgentRelease } from '@deepseek-ai/dsh-company-cloud-agent/types'
import type { WecomBindingId, WecomRequest, WecomRequestId, WecomSnapshot } from '../src/types.ts'
import type { WecomView } from '../src/client/controller.ts'
import { en, zh, type WecomLocaleKey } from '../src/client/locales.ts'
import { WecomAgentChannel, WecomPage, WecomPublishCard, WecomToast } from '../src/client/views.tsx'

const REQUEST_ID = brandString<WecomRequestId>('request-1')
const BINDING_ID = brandString<WecomBindingId>('binding-1')
const request: WecomRequest = { id: REQUEST_ID, ownerId: brandString<WecomRequest['ownerId']>('local-owner'), agentId: brandString<WecomRequest['agentId']>('agent-1'), releaseId: brandString<WecomRequest['releaseId']>('release-1'),
  name: 'Sales assistant', expiresAt: Date.now() + 60_000, bindingId: null }
const snapshot: WecomSnapshot = { source: 'test-deployment', requests: [request], bindings: [] }
const binding = (status: WecomSnapshot['bindings'][number]['status']): WecomSnapshot['bindings'][number] => ({
  id: BINDING_ID, ownerId: request.ownerId, botId: 'robot-1', agentId: request.agentId, releaseId: request.releaseId, name: request.name,
  requestId: REQUEST_ID, enabled: status !== 'disabled', status,
})
const unused = (): never => { throw new Error('This component does not consume this framework seat') }
const globals: GlobalStandardProps = {
  usePanelInfo: unused, useRemoteAccess: unused, useSessions: unused, useSessionStatus: unused,
  useSessionRetainInfo: unused, useSessionAccess: unused, useResource: unused,
  useWorkspaces: unused, useWorkspaceAccess: unused,
}
const scope: Omit<SessionStandardProps, 'inputActions'> = {
  sessionId: brandString<SessionStandardProps['sessionId']>('session-1'), useSession: unused, useProjection: unused, useAccess: unused,
  useChat: unused, useConversation: unused, useInput: unused, useTrajectory: unused,
}

function fixture(patch: Partial<WecomView> = {}, copy: Record<WecomLocaleKey, string> = en) {
  let view: WecomView = { snapshot, busy: null, error: null, authorizationUncertain: null, notice: null, ...patch }
  const actions = { authorize: vi.fn(), requestRelease: vi.fn(), setEnabled: vi.fn(), refresh: vi.fn(), dismissNotice: vi.fn() }
  const dictionary: Readonly<Record<string, string | undefined>> = copy
  const shared: Pick<Parameters<typeof WecomPage>[0], 'useWecom' | 't'> & typeof actions = {
    ...actions, useWecom: selector => selector(view), t: (key) => {
      const text = dictionary[key]
      if (text === undefined) throw new Error(`Missing WeCom test translation: ${key}`)
      return text
    },
  }
  const page = { ...globals, ...shared, view: 'page' as const }
  const toast = { ...globals, ...shared }
  return { actions, shared, page, toast, set: (patch: Partial<WecomView>) => { view = { ...view, ...patch } } }
}

function tool(test: ReturnType<typeof fixture>, action: string, output: unknown, isError = false): Parameters<typeof WecomPublishCard>[0] {
  const args = PartialArguments.fromObject({ action })
  return {
    ...globals, ...scope, ...test.shared,
    // The unused input-action seat must fail if this result view starts consuming it.
    inputActions: new Proxy({} as SessionStandardProps['inputActions'], { get: unused }),
    callId: 'call-1', toolName: 'wecom_publish', useDisclosure: unused, openFile: unused, loadImage: unused,
    phase: 'result', block: {
      kind: 'tool-result', seq: 2, time: 2, callId: 'call-1', name: 'wecom_publish', args,
      call: { name: 'wecom_publish', argsRaw: JSON.stringify({ action }) }, callTime: 1,
      content: [{ type: 'text', text: typeof output === 'string' ? output : JSON.stringify(output) }], isError, subCalls: [],
    },
  }
}

function publication(test: ReturnType<typeof fixture>) {
  const props = tool(test, 'authorize', { requestId: REQUEST_ID, name: request.name, state: 'awaiting_scan' })
  if (props.phase === 'result') props.block.meta = { wecomRequestId: REQUEST_ID }
  return props
}

afterEach(() => { cleanup(); vi.useRealTimers() })

it('shows only the sidebar release channels and requests that exact release without publishing edits', () => {
  const release: CloudAgentRelease = { id: request.releaseId, kind: 'published', version: 1, draftRevision: 1,
    definition: { name: request.name, description: 'Pinned release', instructions: 'Use approved tools.', provider: 'fixture', model: 'fixture' }, createdAt: 1 }
  const record: CloudAgentRecord = { id: request.agentId, ownerId: brandString<CloudAgentRecord['ownerId']>('owner'), revision: 2,
    draft: { ...release.definition, name: 'Unpublished changes' }, releases: [release], publishedReleaseId: release.id, createdAt: 1, updatedAt: 2 }
  const test = fixture({ snapshot: { ...snapshot, requests: [], bindings: [binding('online'),
    { ...binding('offline'), id: brandString<WecomBindingId>('another-robot'), releaseId: brandString<CloudAgentRelease['id']>('another-release'), name: 'Other release' }] } })
  render(<WecomAgentChannel {...globals} {...scope}
    {...test.shared} record={record} release={release} />)
  expect(screen.getByText(request.name)).toBeTruthy()
  expect(screen.queryByText('Other release')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.requestScan }))
  expect(test.actions.requestRelease).toHaveBeenCalledExactlyOnceWith(record.id, release.id)
})

describe('WecomPublishCard', () => {
  it('shows saved catalog names, ids, revisions and publication versions without scan actions', () => {
    const test = fixture({ snapshot: null })
    render(<WecomPublishCard {...tool(test, 'catalog', { agents: [
      { id: 'saved-1', name: 'Sales analyst', revision: 7, publishedReleaseId: 'release-7' },
      { id: 'saved-2', name: 'Support helper', revision: 2, publishedReleaseId: null },
    ] })} />)
    expect(screen.getByText(en.catalog)).toBeTruthy()
    for (const text of ['Sales analyst', 'saved-1', '7', 'release-7', 'Support helper', en.unpublished]) {
      expect(screen.getByText(text)).toBeTruthy()
    }
    expect(screen.queryByRole('button')).toBeNull()
    expect(test.actions.refresh).not.toHaveBeenCalled()
  })

  it('shows the empty catalog prerequisite', () => {
    render(<WecomPublishCard {...tool(fixture(), 'catalog', { agents: [] })} />)
    expect(screen.getByText(en.catalogEmpty)).toBeTruthy()
  })

  it('shows recorded connection states and pending authorization without implying live success', () => {
    const test = fixture({ snapshot: { ...snapshot, bindings: [{ ...binding('online'), name: 'Current live robot' }] } })
    render(<WecomPublishCard {...tool(test, 'status', {
      bindings: ['connecting', 'disabled', 'offline', 'online'].map((status, index) => ({ id: `robot-${index}`, name: `Recorded ${status}`, status })),
      requests: [{ id: 'pending-1', name: 'Needs scan', bindingId: null }, { id: 'bound-1', name: 'Already bound', bindingId: 'robot-0' }],
    })} />)
    expect(screen.getByText(en.recorded)).toBeTruthy()
    for (const status of ['connecting', 'disabled', 'offline', 'online'] as const) {
      expect(screen.getByText(en[status])).toBeTruthy()
    }
    expect(screen.getByText('Needs scan')).toBeTruthy()
    expect(screen.getByText(en.unauthorized)).toBeTruthy()
    expect(screen.queryByText('Already bound')).toBeNull()
    expect(screen.queryByText('Current live robot')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows an empty recorded status', () => {
    render(<WecomPublishCard {...tool(fixture(), 'status', { bindings: [], requests: [] })} />)
    expect(screen.getByText(en.statusEmpty)).toBeTruthy()
  })

  it.each([
    ['catalog', '{not json}'], ['catalog', 'null'], ['catalog', '{"agents":[{"name":"missing identity"}]}'],
    ['catalog', '{"agents":[{"id":"duplicate","name":"A","revision":1,"publishedReleaseId":null},{"id":"duplicate","name":"B","revision":2,"publishedReleaseId":null}]}'],
    ['status', '{"bindings":[{"id":"x","name":"Unknown status","status":"unexpected"}],"requests":[]}'],
    ['status', '{"bindings":[],"requests":[{"id":"x","name":"A","bindingId":null},{"id":"x","name":"B","bindingId":null}]}'],
    ['other', '{"custom":"unfamiliar result"}'],
  ])('preserves generic output for malformed or unknown %s data', (action, text) => {
    render(<WecomPublishCard {...tool(fixture(), action, text)} />)
    expect(screen.getByText(text)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.scan })).toBeNull()
  })

  it('keeps tool failure output with a details action instead of claiming authorization failed', () => {
    const props = tool(fixture(), 'catalog', 'Choose one saved agent', true)
    const inspect = vi.fn()
    render(<WecomPublishCard {...props} inspect={inspect} />)
    expect(screen.getByRole('alert').textContent).toBe(en.toolFailed)
    expect(screen.getByText('Choose one saved agent')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.details }))
    expect(inspect).toHaveBeenCalledOnce()
  })

  it('offers scanning only for an unauthorized request', () => {
    const test = fixture()
    render(<WecomPublishCard {...publication(test)} />)
    expect(screen.getByText(en.unauthorized)).toBeTruthy()
    expect(screen.getByText(en.awaiting)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.scan }))
    expect(test.actions.authorize).toHaveBeenCalledExactlyOnceWith(REQUEST_ID)
    expect(screen.queryByText(en.authorized)).toBeNull()
  })

  it.each(['connecting', 'online', 'disabled', 'offline'] as const)('presents authorized %s separately from scan state', (status) => {
    const test = fixture({ snapshot: { ...snapshot, requests: [{ ...request, bindingId: BINDING_ID }], bindings: [binding(status)] } })
    render(<WecomPublishCard {...publication(test)} />)
    expect(screen.getByText(en[status])).toBeTruthy()
    expect(screen.getByText(en[`${status}Description`])).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.scan })).toBeNull()
    const enable = screen.queryByRole('button', { name: en.enable })
    const reconnect = screen.queryByRole('button', { name: en.reconnect })
    expect(enable !== null).toBe(status === 'disabled')
    expect(reconnect !== null).toBe(status === 'offline')
    if (enable !== null) fireEvent.click(enable)
    if (reconnect !== null) fireEvent.click(reconnect)
    if (status === 'offline' || status === 'disabled') expect(test.actions.setEnabled).toHaveBeenCalledExactlyOnceWith(BINDING_ID, true)
    if (status !== 'connecting') expect(screen.queryByText(en.connectingDescription)).toBeNull()
  })

  it('keeps a binding visible after its short-lived request leaves the snapshot', () => {
    const test = fixture({ snapshot: { ...snapshot, requests: [], bindings: [binding('disabled')] } })
    render(<WecomPublishCard {...publication(test)} />)
    expect(screen.getByText(request.name)).toBeTruthy()
    expect(screen.getByText(en.disabledDescription)).toBeTruthy()
    expect(screen.queryByText(en.unavailable)).toBeNull()
  })

  it('resolves the request binding id without displaying an unrelated robot', () => {
    const unrelated = { ...binding('online'), id: brandString<WecomBindingId>('unrelated-binding'),
      requestId: brandString<WecomRequestId>('unrelated-request'), name: 'Unrelated robot' }
    const bound = { ...binding('disabled'), requestId: brandString<WecomRequestId>('earlier-request') }
    const test = fixture({ snapshot: { ...snapshot, requests: [{ ...request, bindingId: BINDING_ID }], bindings: [unrelated, bound] } })
    render(<WecomPublishCard {...publication(test)} />)
    expect(screen.getByText(request.name)).toBeTruthy()
    expect(screen.getByText(en.disabledDescription)).toBeTruthy()
    expect(screen.queryByText('Unrelated robot')).toBeNull()
    expect(screen.queryByRole('button', { name: en.scan })).toBeNull()
  })

  it('refreshes unavailable authorization results without offering a new blind scan', () => {
    const unrelated = { ...binding('online'), requestId: brandString<WecomRequestId>('unrelated-request'), name: 'Unrelated robot' }
    const test = fixture({ snapshot: { ...snapshot, requests: [], bindings: [unrelated] } })
    render(<WecomPublishCard {...publication(test)} />)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    expect(test.actions.refresh).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: en.scan })).toBeNull()
    expect(screen.queryByText('Unrelated robot')).toBeNull()
  })

  it('uses the shared spinner while preparing, running or awaiting its first status', () => {
    const test = fixture({ snapshot: null })
    const settled = publication(test)
    if (settled.phase !== 'result') throw new Error('Expected result fixture')
    const head = { name: 'wecom_publish', callId: 'call-1', time: 1, turn: 1, step: 1, args: settled.block.args, subCalls: [] }
    const { rerender } = render(<WecomPublishCard {...settled} phase="preparing" block={{ ...head, phase: 'preparing' }} />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en.working)
    expect(screen.queryByText(en.working)).toBeNull()
    rerender(<WecomPublishCard {...settled} phase="start" block={{ ...head, phase: 'start', argsRaw: '{}' }} />)
    expect(screen.getByRole('status').querySelector('svg')).toBeTruthy()
    rerender(<WecomPublishCard {...settled} />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en.loading)
  })
})

describe('WecomPage and shell Toast', () => {
  it('renders only descriptive text in the plugin summary without duplicate controls', () => {
    const test = fixture({ snapshot: { ...snapshot, bindings: [binding('online')] } })
    render(<WecomPage {...test.page} view="summary" />)
    expect(screen.getByText(en.description)).toBeTruthy()
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(request.name)).toBeNull()
  })

  it('centers the shared spinner during initial loading and stops it on query failure', () => {
    const test = fixture({ snapshot: null })
    const { rerender } = render(<WecomPage {...test.page} />)
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe(en.loading)
    expect(screen.getByRole('status').querySelector('svg')).toBeTruthy()
    expect(screen.queryByText(en.loading)).toBeNull()
    test.set({ error: 'statusFailed' })
    rerender(<WecomPage {...test.page} />)
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(test.actions.refresh).toHaveBeenCalledOnce()
  })

  it('retains robots and pending requests beside persistent stream errors and Retry', () => {
    const test = fixture({ error: 'statusFailed', snapshot: { ...snapshot, bindings: [{ ...binding('offline'), requestId: brandString<WecomRequestId>('other-request') }] } })
    render(<WecomPage {...test.page} />)
    expect(screen.getByRole('alert').textContent).toContain(en.statusFailed)
    expect(screen.getAllByText(request.name)).toHaveLength(2)
    expect(screen.getByText(en.offlineDescription)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.scan }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(test.actions.refresh).toHaveBeenCalledOnce()
  })

  it('changes enablement, reconnects only offline robots and disables overlapping actions', () => {
    const test = fixture({ snapshot: { ...snapshot, requests: [], bindings: [binding('offline')] } })
    const { rerender } = render(<WecomPage {...test.page} />)
    fireEvent.click(screen.getByRole('button', { name: en.disable }))
    fireEvent.click(screen.getByRole('button', { name: en.reconnect }))
    expect(test.actions.setEnabled.mock.calls).toEqual([[BINDING_ID, false], [BINDING_ID, true]])
    test.set({ busy: BINDING_ID })
    rerender(<WecomPage {...test.page} />)
    for (const button of screen.getAllByRole('button')) expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('shows an empty management page without a loading indicator', () => {
    render(<WecomPage {...fixture({ snapshot: { ...snapshot, requests: [], bindings: [] } }).page} />)
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByText(en.title)).toBeNull()
    expect(screen.queryByText(en.description)).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it.each([en, zh])('requires localized refresh before another scan after an uncertain completion', (copy) => {
    const test = fixture({ authorizationUncertain: REQUEST_ID, notice: { sequence: 1, key: 'authorization-uncertain', success: false } }, copy)
    const { rerender } = render(<><WecomPublishCard {...publication(test)} /><WecomToast {...test.toast} /></>)
    expect(screen.getByRole('button', { name: copy.scan }).hasAttribute('disabled')).toBe(true)
    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)
    for (const alert of alerts) expect(alert.textContent).toContain(copy['authorization-uncertain'])
    fireEvent.click(within(alerts[0]!).getByRole('button', { name: copy.refresh }))
    fireEvent.click(within(alerts[1]!).getByRole('button', { name: copy.refresh }))
    expect(test.actions.refresh).toHaveBeenCalledTimes(2)
    expect(test.actions.authorize).not.toHaveBeenCalled()
    test.set({ notice: null })
    rerender(<><WecomPage {...test.page} /><WecomToast {...test.toast} /></>)
    expect(screen.getByRole('alert').textContent).toContain(copy['authorization-uncertain'])
    expect(screen.getByRole('button', { name: copy.scan }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps transient feedback after the reporting page closes and dismisses the matching sequence', () => {
    vi.useFakeTimers()
    const test = fixture({ notice: { sequence: 9, key: 'robotDisabled', success: true } })
    const { rerender } = render(<><WecomPage {...test.page} /><WecomToast {...test.toast} /></>)
    rerender(<WecomToast {...test.toast} />)
    expect(screen.getByRole('alert').textContent).toBe(en.robotDisabled)
    expect(screen.queryByText(en.title)).toBeNull()
    vi.advanceTimersByTime(4_000)
    expect(test.actions.dismissNotice).toHaveBeenCalledExactlyOnceWith(9)
  })

  it('does not show a Toast while pending and preserves an ordinary failure as shell feedback only', () => {
    const test = fixture({ busy: REQUEST_ID })
    const { rerender } = render(<><WecomPage {...test.page} /><WecomToast {...test.toast} /></>)
    expect(screen.queryByRole('alert')).toBeNull()
    test.set({ busy: null, notice: { sequence: 1, key: 'blocked', success: false } })
    rerender(<><WecomPage {...test.page} /><WecomToast {...test.toast} /></>)
    expect(screen.getByRole('alert').textContent).toBe(en.blocked)
    expect(screen.getByText(request.name)).toBeTruthy()
    expect(screen.queryByRole('button', { name: en.retry })).toBeNull()
  })
})
