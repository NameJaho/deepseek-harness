/** Focused durable publication, ownership, preset audit and single-provider execution regressions. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent, type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access'
import { remoteMethods, type RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol'
import type { CompanyUserPrincipal, WecomResourceProvider, WecomUserPrincipal } from '@deepseek-ai/dsh-company-wecom-auth/types'
import { createScope } from '@deepseek-ai/dsh-scope'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import ToolRegistry, { defineTool, projectToolSchema, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import Commands from '@deepseek-ai/dsh-commands'
import Knowledge, { Config as KnowledgeConfig } from '@deepseek-ai/dsh-company-knowledge'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { expect, it, vi, type TestContext } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import CloudAgents, { type Config } from '../src/index.ts'
import { toolFingerprint } from '../src/capabilities.ts'
import type { CloudAgentConversation, CloudAgentDraft, CloudAgentOwnerId } from '../src/types.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

interface FixtureWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: SessionId[]
  attachSession(id: SessionId): Promise<void>
}

async function fixture(test: TestContext, pool = new MemoryMediaPool(), storedSessions: Session[] = [], withMcp = true) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-host-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(pool)
  ctx.storage.backend.register('test', backend)
  ctx.provide(storageBackendServiceKey('test'), backend)
  await ctx.plugin(StorageDomain, { backend: 'test' })
  await ctx.plugin(Projections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(Commands)
  const agents = new Map<SessionId, Agent>()
  const declared = new Map<string, unknown>()
  const permissions = new Map<Session, string>()
  const guards = new Set<(session: Session, name: string) => void>()
  const owners = new Map<SessionId, string>()
  let owner = 'wecom:corp:alice'
  let serial = 0
  const providerStops: (() => Promise<void>)[] = []
  let forkPlacement: ((header: Session['header'], childId: SessionId) => Promise<unknown>) | undefined
  const createAgent = async (options: CreateAgentOptions): Promise<AgentHandle> => {
    const session = Session.create(options.sessionId, [],
      { version: 4, id: options.sessionId, createdAt: Date.now(), isSeeded: false, ...options.meta })
    // The fixture exercises Host lifecycle methods, not the Agent driver or inbox.
    const agent = { id: session.id, session } as Agent
    const scope = createScope(ctx, agent)
    Object.assign(agent, { ctx: scope.ctx, model: { current: () => ({ provider: 'fixture', model: 'fixture' }), select: vi.fn() } })
    agents.set(agent.id, agent)
    owners.set(agent.id, owner)
    await options.setup?.(scope.ctx, agent)
    await ctx.serial('agent/created', { agent, source: 'startup' })
    return { agent, dispose: async () => { agents.delete(agent.id); await scope.dispose() } }
  }
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(RemoteAccess)
  vi.spyOn(ctx.agents, 'get').mockImplementation(id => agents.get(id))
  vi.spyOn(ctx.agents, 'list').mockImplementation(() => [...agents.values()])
  vi.spyOn(ctx.agents, 'create').mockImplementation(createAgent)
  ctx.provide('agentPresets', { defaultId: 'standard',
    availabilityOf: (id: string) => ['standard', 'ptc'].includes(id) ? 'selectable' : 'retained',
    resolve: async (id: string) => ({ id }), resolveRetained: async (id: string) => ({ id }),
    register: async (definition: { id: string }) => {
      declared.set(definition.id, definition)
      return async () => { declared.delete(definition.id) }
    },
    acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => undefined }),
    composedPreset: (agentCtx: Context) => [...agents.values()].find(agent => agent.ctx === agentCtx)?.session.header.agentPreset,
    presetForSession: (session: Session) => session.header.agentPreset,
    mount: async () => {}, mountRetained: async () => {},
  } as never)
  const queued = vi.fn(async () => {})
  ctx.provide('sessionController', { resolveAgent: async (id: SessionId) => ({ agent: agents.get(id) }),
    modelCatalog: async () => ({ default: { provider: 'fixture', model: 'fixture' }, routableProviders: ['fixture'], groups: [], failures: [] }),
    prompt: queued,
    registerCreationProvider: () => { const stop = async () => {}; providerStops.push(stop); return stop },
    registerForkPlacementProvider: (provider: typeof forkPlacement) => {
      forkPlacement = provider
      const stop = async () => { forkPlacement = undefined }
      providerStops.push(stop)
      return stop
    },
  } as never)
  ctx.provide('permissionPresets', { current: (session: Session) => permissions.get(session) ?? 'workspace-write',
    set: (session: Session, name: string) => { for (const guard of guards) guard(session, name); permissions.set(session, name) },
    registerGuard: (guard: (session: Session, name: string) => void) => { guards.add(guard); return () => { guards.delete(guard) } },
  } as never)
  ctx.provide('llm', { resolveCallConfig: async () => ({}) } as never)
  const workspaces = new Map<string, FixtureWorkspace>()
  ctx.provide('workspaceRegistry', { create: async (path: string, title: string) => {
    const workspace: FixtureWorkspace = { id: `workspace-${++serial}`, path, title, sessionIds: [],
      attachSession: async (id: SessionId) => { workspace.sessionIds.push(id) } }
    workspaces.set(workspace.id, workspace); return workspace
  }, list: () => [...workspaces.values()], delete: async (id: string) => { workspaces.delete(id) } } as never)
  ctx.provide('sessionPersistence', {
    list: async () => storedSessions.map(session => ({ header: session.header })),
    open: async (id: SessionId) => ({
      read: async () => ({ events: storedSessions.find(session => session.id === id)!.snapshotEvents() }),
      [Symbol.asyncDispose]: async () => {},
    }),
  } as never)
  let initiatorOwnership = false
  const resources = new Set<WecomResourceProvider>()
  ctx.remoteAccess.registerPolicy('wecom-user', { bindings: principal => [...resources].flatMap(provider => provider.bindings(principal)) })
  ctx.remoteAccess.registerPolicy('gateway-user', { bindings: principal => [...resources].flatMap(provider => provider.bindings(principal)) })
  ctx.provide('companyWecomAuth', {
    ownerScope: (principal?: CompanyUserPrincipal) => {
      if (principal !== undefined) return brandString<CloudAgentOwnerId>(principal.kind === 'wecom-user'
        ? `wecom:${principal.corpId}:${principal.userId}` : `gateway:${principal.userId}`)
      const agent = ctx.agents.currentInitiator()
      return brandString<CloudAgentOwnerId>(initiatorOwnership ? owners.get(agent?.id ?? SessionId('missing')) ?? 'local-owner' : owner)
    },
    sessionOwner: (id: SessionId) => owners.get(id), defaultWorkspaceSessions: () => [], sessionBindings: () => [],
    registerResourceProvider: (provider: WecomResourceProvider) => {
      resources.add(provider)
      return async () => { resources.delete(provider) }
    },
  } as never)
  const call = vi.fn(async () => 'PINNED_RESULT')
  let description = 'Approved tool'
  let enabled = true
  const tool = () => defineTool({ name: 'mcp__sales__ping', description, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute: call })
  const resolved = () => {
    const definition = tool()
    const schema = projectToolSchema(definition, false)
    return { tool: definition, schema, fingerprint: toolFingerprint(schema) }
  }
  const summary = () => ({ name: 'mcp__sales__ping', rawName: 'ping', description, parametersJson: '{}', fingerprint: resolved().fingerprint })
  if (withMcp) ctx.provide('companyMcpProvider', { resolveTool: async () => enabled ? resolved() : undefined,
    discoverTools: async () => { if (!enabled) throw new Error('Disabled provider'); return [summary()] },
    capabilityCatalog: async () => [{ id: 'sales', name: 'Sales', description: '', namespace: 'sales', enabled, status: 'available', toolNames: ['mcp__sales__ping'] }],
    catalog: async () => ({ loaded: true, servers: [{ id: 'sales', name: 'Sales', description: '', enabled, status: 'available', tools: [summary()] }] }),
  } as never)
  const fiber = ctx.plugin(CloudAgents, CloudAgents.Config({ workspaceRoot: root } as Config))
  await fiber
  const editor = async () => (await ctx.cloudAgents.startAuthoring({}, new AbortController().signal)).sessionId
  const draft: CloudAgentDraft = { name: 'Sales', description: 'Approved sales analysis', instructions: 'Use only approved evidence.', provider: 'fixture', model: 'fixture', mcpTools: ['mcp__sales__ping'] }
  return { ctx, fiber, editor, agents, declared, guards, queued, call, draft, workspaces,
    initiatorOwnership: () => { initiatorOwnership = true },
    setOwner: (id: string) => { owner = `wecom:corp:${id}` }, changeTool: () => { description = 'Changed schema' },
    setGatewayOwner: (id: string) => { owner = `gateway:${id}` },
    disable: () => { enabled = false }, fork: (header: Session['header'], id: SessionId) => forkPlacement?.(header, id) }
}

it('pins the saved revision, rejects changed schemas, and deduplicates explicit publication replays', async (test) => {
  const f = await fixture(test)
  const sessionId = await f.editor()
  const agent = f.agents.get(sessionId)!
  const saved = await f.ctx.cloudAgents.saveFromConversation(agent, 'save-once', f.draft)
  expect(await f.ctx.cloudAgents.saveFromConversation(agent, 'save-once', f.draft)).toEqual(saved)
  expect(saved.draftMcpBindings).toHaveLength(1)
  const request = { id: saved.id, expectedRevision: saved.revision, visibility: 'public' as const, authoringSessionId: sessionId }
  const published = await f.ctx.cloudAgents.publish(request)
  expect(await f.ctx.cloudAgents.publish(request)).toEqual(published)
  expect(published.releases).toHaveLength(1)
  const release = published.releases[0]!
  expect(release.mcpBindings).toEqual(saved.draftMcpBindings)
  expect(release.source).toMatchObject({ sessionId, preset: 'standard', permission: 'workspace-write' })
  expect(release.digest).toMatch(/^[a-f0-9]{64}$/)
  await expect(f.ctx.cloudAgents.publish({ ...request, visibility: 'private' })).rejects.toMatchObject({ code: 'cloud-agent/conflict' })
  f.changeTool()
  await expect(f.ctx.cloudAgents.validateCapabilities(release.id)).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  await expect(f.ctx.cloudAgents.publish({ ...request, expectedRevision: published.revision })).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  expect((await f.ctx.cloudAgents.catalog()).mine[0]?.releases).toHaveLength(1)
})

it('filters public-or-own releases, retains caller ownership, and audits restricted selectable run presets', async (test) => {
  const f = await fixture(test)
  const editor = await f.editor()
  const saved = await f.ctx.cloudAgents.create(f.draft, editor)
  let record = await f.ctx.cloudAgents.publish({ id: saved.id, expectedRevision: saved.revision, authoringSessionId: editor })
  const releaseId = record.publishedReleaseId!
  f.setOwner('bob')
  const catalog = await f.ctx.cloudAgents.catalog()
  expect(catalog.mine).toEqual([])
  expect(catalog.conversations).toEqual([])
  expect(catalog.published[0]?.release.source).toBeUndefined()
  await expect(f.ctx.cloudAgents.startSession({ id: record.id, releaseId, runPreset: 'cloud-agent-authoring' }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'cloud-agent/preset-unavailable' })
  const usage = await f.ctx.cloudAgents.startSession({ id: record.id, releaseId, runPreset: 'ptc' }, new AbortController().signal)
  const binding = (await f.ctx.cloudAgents.catalog()).conversations[0]
  expect(binding).toMatchObject({ sessionId: usage.sessionId, ownerId: 'wecom:corp:bob', creationPreset: 'standard', runPreset: 'ptc' })
  expect(binding?.effectiveDigest).toMatch(/^[a-f0-9]{64}$/)
  const agent = f.agents.get(usage.sessionId)!
  expect(agent.session.header.agentPreset).toBe(`cloud-agent-${releaseId}`)
  expect(() =>{  f.ctx.permissionPresets.set(agent.session, 'danger-full-access') }).toThrow(expect.objectContaining({ code: 'cloud-agent/authoring-required' }))
  const [tool] = await f.ctx.cloudAgents.releaseMcpTools(releaseId)
  expect(await tool!.execute({}, { agent, signal: new AbortController().signal } as ToolRunContext)).toBe('PINNED_RESULT')
  expect(f.call).toHaveBeenCalledOnce()
  await expect(tool!.execute({}, { agent: f.agents.get(editor), signal: new AbortController().signal } as ToolRunContext)).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('available')
  f.setOwner('alice')
  record = await f.ctx.cloudAgents.publish({ id: record.id, expectedRevision: record.revision, authoringSessionId: editor, visibility: 'private' })
  f.setOwner('bob')
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('access-lost')
  expect((await f.ctx.cloudAgents.catalog()).published).toEqual([])
  await expect(f.ctx.cloudAgents.startSession({ id: record.id, releaseId: record.publishedReleaseId! }, new AbortController().signal)).rejects.toMatchObject({ code: 'cloud-agent/not-published' })
  await expect(f.ctx.cloudAgents.update({ id: record.id, expectedRevision: record.revision, draft: f.draft, authoringSessionId: editor })).rejects.toMatchObject({ code: 'cloud-agent/owner-required' })
  // Existing private Sessions keep the pinned release despite a publication visibility change.
  expect(await tool!.execute({}, { agent, signal: new AbortController().signal } as ToolRunContext)).toBe('PINNED_RESULT')
})

it('reports updated, disabled, withdrawn and deleted usage without redirecting old bindings', async (test) => {
  const f = await fixture(test)
  const editor = await f.editor()
  const saved = await f.ctx.cloudAgents.create(f.draft, editor)
  let record = await f.ctx.cloudAgents.publish({ id: saved.id, expectedRevision: saved.revision, authoringSessionId: editor })
  f.setOwner('bob')
  const usage = await f.ctx.cloudAgents.startSession({ id: record.id, releaseId: record.publishedReleaseId! }, new AbortController().signal)
  f.setOwner('alice')
  record = await f.ctx.cloudAgents.publish({ id: record.id, expectedRevision: record.revision, authoringSessionId: editor })
  f.setOwner('bob')
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('updated')
  f.disable()
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('disabled')
  f.setOwner('alice')
  record = await f.ctx.cloudAgents.unpublish({ id: record.id, expectedRevision: record.revision, authoringSessionId: editor })
  f.setOwner('bob')
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('withdrawn')
  f.setOwner('alice')
  await f.ctx.cloudAgents.delete({ id: record.id, expectedRevision: record.revision })
  f.setOwner('bob')
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('deleted')
  expect((await f.ctx.cloudAgents.catalog()).conversations[0]?.sessionId).toBe(usage.sessionId)
  await f.fiber.dispose()
  expect(f.guards.size).toBe(0)
  expect(f.declared.size).toBe(0)
})

it('queues an ordinary-session draft, shows its revision, and publishes directly only on explicit confirmation', async (test) => {
  const f = await fixture(test)
  const sessionId = await f.editor()
  const agent = f.agents.get(sessionId)!
  expect(agent.session.header.agentPreset).toBe('standard')
  expect(f.ctx.commands.list(agent).map(command => command.name)).toEqual(['create-agent', 'publish-agent'])
  const run = (line: string) => f.ctx.commands.execute(agent, line, [], new AbortController().signal)
  expect((await run('/publish-agent confirm 1 public'))?.result.kind).toBe('error')
  expect(f.queued).not.toHaveBeenCalled()
  expect((await run('/publish-agent'))?.result.kind).toBe('success')
  expect(f.queued).toHaveBeenCalledWith(expect.objectContaining({ sessionId, mode: 'queue', content: [expect.objectContaining({
    type: 'text', text: expect.stringContaining('Do not publish.') as string,
  })] }), expect.any(AbortSignal))
  const saved = await f.ctx.cloudAgents.saveFromConversation(agent, 'confirmed-draft', f.draft)
  const review = await run('/publish-agent')
  expect(review?.result.text).toContain(saved.draft.name)
  expect(review?.result.text).toContain(saved.draft.description)
  expect(review?.result.text).toContain(`/publish-agent confirm ${saved.revision} <public|private>`)
  expect((await f.ctx.cloudAgents.catalog()).mine[0]?.releases).toEqual([])
  const confirm = `/publish-agent confirm ${saved.revision} private`
  const result = await run(confirm)
  expect(result?.result.kind).toBe('success')
  expect((await run(confirm))?.result.kind).toBe('success')
  expect(f.queued).toHaveBeenCalledOnce()
  const published = (await f.ctx.cloudAgents.catalog()).mine[0]!
  expect(published.releases).toHaveLength(1)
  expect(published.releases[0]?.visibility).toBe('private')
  expect(published.releases[0]?.source?.throughSeq).toBeGreaterThan(saved.sourceThroughSeq!)
  await expect(run(`/publish-agent confirm ${saved.revision} public`)).rejects.toMatchObject({ code: 'cloud-agent/conflict' })
  f.ctx.permissionPresets.set(agent.session, 'read-only')
  expect((await run('/create-agent more requirements'))?.result.kind).toBe('error')
  expect((await run('/publish-agent'))?.result.kind).toBe('error')
  await f.fiber.dispose()
  expect(f.ctx.commands.list(agent)).toEqual([])
})

it('confirms a member draft from a command without inheriting another caller or local-owner', async (test) => {
  const f = await fixture(test)
  const editor = await f.editor()
  const agent = f.agents.get(editor)!
  const saved = await f.ctx.cloudAgents.create(f.draft, editor)
  f.setOwner('bob')
  const other = await f.ctx.cloudAgents.startAuthoring({}, new AbortController().signal)
  f.initiatorOwnership()
  const result = await f.ctx.agents.withInitiator(f.agents.get(other.sessionId)!, () =>
    f.ctx.commands.execute(agent, `/publish-agent confirm ${saved.revision} private`, [], new AbortController().signal))
  expect(result?.result.kind).toBe('success')
  const catalog = await f.ctx.agents.withInitiator(agent, () => f.ctx.cloudAgents.catalog())
  expect(catalog.mine[0]?.releases).toHaveLength(1)
  expect(catalog.mine[0]?.ownerId).toBe('wecom:corp:alice')
  expect(f.ctx.agents.currentInitiator()).toBeUndefined()
})

for (const kind of ['wecom-user', 'gateway-user'] as const) {
  it(`returns only owned conversation rows for ${kind} catalog and follow`, async (test) => {
    const f = await fixture(test)
    const editor = await f.editor()
    const saved = await f.ctx.cloudAgents.create(f.draft, editor)
    const record = await f.ctx.cloudAgents.publish({ id: saved.id, expectedRevision: saved.revision, authoringSessionId: editor })
    if (kind === 'wecom-user') f.setOwner('bob')
    else f.setGatewayOwner('bob')
    const usage = await f.ctx.cloudAgents.startSession({ id: record.id, releaseId: record.publishedReleaseId! },
      new AbortController().signal)
    const member = { userId: brandString<WecomUserPrincipal['userId']>('bob'),
      identityId: brandString<WecomUserPrincipal['identityId']>('bob'), role: 'user' as const }
    const principal: CompanyUserPrincipal = kind === 'wecom-user'
      ? { ...member, kind, corpId: brandString<WecomUserPrincipal['corpId']>('corp') }
      : { ...member, kind, displayName: 'Bob' }
    const invoke = (method: string) => {
      const signal = new AbortController().signal
      const invocation: RemoteInvocation = { request: { namespace: 'cloudAgents', method, args: {} }, service: 'cloudAgents', signal,
        peer: { id: brandString<RemoteInvocation['peer']['id']>('member-peer'), ctx: f.ctx, principal, interactions: 'answer', signal, dispose: async () => {} },
        uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      }
      return f.ctx.extend({ invocation }).cloudAgents
    }
    expect((await invoke('catalog').catalog()).conversations.map(item => item.sessionId)).toEqual([usage.sessionId])
    const follower = invoke('follow').follow(new AbortController().signal)[Symbol.asyncIterator]()
    try {
      const first = await follower.next()
      if (first.done === true) throw new Error('Missing initial catalog')
      expect(first.value.conversations.map((item: CloudAgentConversation) => item.sessionId)).toEqual([usage.sessionId])
    } finally { await follower.return?.() }
    expect(f.ctx.remoteAccess.decide({ principal, action: 'cloudAgents/catalog', resources: [{ kind: 'session', id: editor }] }).kind).toBe('deny')
  })
}

it('rejects a schema refresh between capability validation and wrapper registration', async (test) => {
  const f = await fixture(test)
  const editor = await f.editor()
  const saved = await f.ctx.cloudAgents.create(f.draft, editor)
  const record = await f.ctx.cloudAgents.publish({ id: saved.id, expectedRevision: saved.revision, authoringSessionId: editor })
  const resolve = f.ctx.companyMcpProvider.resolveTool.bind(f.ctx.companyMcpProvider)
  let count = 0
  vi.spyOn(f.ctx.companyMcpProvider, 'resolveTool').mockImplementation(async (name) => {
    if (++count === 2) f.changeTool()
    return resolve(name)
  })
  await expect(f.ctx.cloudAgents.releaseMcpTools(record.publishedReleaseId!)).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  expect(f.call).not.toHaveBeenCalled()
})

it('rechecks the receiving release after asynchronous validation before MCP dispatch', async (test) => {
  const f = await fixture(test)
  const editor = await f.editor()
  const saved = await f.ctx.cloudAgents.create(f.draft, editor)
  const record = await f.ctx.cloudAgents.publish({ id: saved.id, expectedRevision: saved.revision, authoringSessionId: editor })
  const usage = await f.ctx.cloudAgents.startSession({ id: record.id, releaseId: record.publishedReleaseId! }, new AbortController().signal)
  const agent = f.agents.get(usage.sessionId)!
  const [tool] = await f.ctx.cloudAgents.releaseMcpTools(record.publishedReleaseId!)
  const resolve = f.ctx.companyMcpProvider.resolveTool.bind(f.ctx.companyMcpProvider)
  let count = 0
  const reached = Promise.withResolvers<undefined>()
  const proceed = Promise.withResolvers<undefined>()
  vi.spyOn(f.ctx.companyMcpProvider, 'resolveTool').mockImplementation(async (name) => {
    if (++count === 2) { reached.resolve(undefined); await proceed.promise }
    return resolve(name)
  })
  const running = tool!.execute({}, { agent, signal: new AbortController().signal } as ToolRunContext)
  await reached.promise
  f.agents.delete(agent.id)
  proceed.resolve(undefined)
  await expect(running).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  expect(f.call).not.toHaveBeenCalled()
})

it('recovers a missing usage index from its log with the original owner and immutable old release', async (test) => {
  const pool = new MemoryMediaPool()
  const f = await fixture(test, pool)
  const editor = await f.editor()
  const saved = await f.ctx.cloudAgents.create(f.draft, editor)
  let record = await f.ctx.cloudAgents.publish({ id: saved.id, expectedRevision: saved.revision, authoringSessionId: editor })
  const oldRelease = record.releases[0]!
  f.setOwner('bob')
  const usage = await f.ctx.cloudAgents.startSession({ id: record.id, releaseId: oldRelease.id }, new AbortController().signal)
  const session = f.agents.get(usage.sessionId)!.session
  const original = (await f.ctx.cloudAgents.catalog()).conversations[0]!
  f.setOwner('alice')
  record = await f.ctx.cloudAgents.publish({
    id: record.id, expectedRevision: record.revision, authoringSessionId: editor, visibility: 'private',
  })
  await f.fiber.dispose()
  expect(pool.media.get('company_cloud_agent')?.tables.get('conversations')?.delete(usage.sessionId)).toBe(true)

  const restarted = await fixture(test, pool, [session])
  const ownerCatalog = await restarted.ctx.cloudAgents.catalog()
  expect(ownerCatalog.conversations.map(item => item.sessionId)).not.toContain(usage.sessionId)
  expect(ownerCatalog.mine[0]?.releases[0]).toEqual(oldRelease)
  expect(ownerCatalog.mine[0]?.publishedReleaseId).toBe(record.publishedReleaseId)
  restarted.setOwner('bob')
  const userCatalog = await restarted.ctx.cloudAgents.catalog()
  expect(userCatalog.conversations).toEqual([original])
  expect(userCatalog.usage[0]).toMatchObject({ agentId: record.id, status: 'access-lost' })
  expect(userCatalog.published).toEqual([])
})

it('reads each Remote editor or source from its actual positional parameter', async (test) => {
  const f = await fixture(test)
  const editor = SessionId('actual-editor')
  const decoy = SessionId('unrelated-session')
  const methods = remoteMethods(f.ctx.cloudAgents)
  const reader = (name: string) => methods.find(method => method.method === name)?.resources?.session
  expect(reader('create')?.({ ...f.draft, authoringSessionId: decoy }, editor)).toBe(editor)
  for (const name of ['update', 'publish', 'unpublish', 'preview', 'clone']) {
    expect(reader(name)?.({ authoringSessionId: editor, sourceSessionId: decoy })).toBe(editor)
  }
  expect(reader('startAuthoring')?.({ sourceSessionId: editor, authoringSessionId: decoy })).toBe(editor)
  expect(reader('deleteUnboundAuthoringSessions')?.({ sessionIds: [editor, decoy] })).toEqual([editor, decoy])
})

it('publishes knowledge-only releases without an MCP provider and rejects foreign sources or changed permissions', async (test) => {
  const f = await fixture(test, undefined, [], false)
  new MemoryCredentials(f.ctx)
  const sources = [{ id: 'operations', name: 'Operations', description: 'Approved evidence',
    searchUrl: 'https://knowledge.example/search', spaceIds: ['approved'] }]
  const knowledgeFiber = await f.ctx.plugin(Knowledge, KnowledgeConfig({ sources }))
  const editor = await f.editor()
  const draft = { ...f.draft, mcpTools: [], knowledgeSources: ['operations'] }
  const saved = await f.ctx.cloudAgents.create(draft, editor)
  const record = await f.ctx.cloudAgents.publish({ id: saved.id, expectedRevision: saved.revision, authoringSessionId: editor })
  const releaseId = record.publishedReleaseId!
  expect(record.releases[0]?.knowledgeBindings).toEqual([f.ctx.companyKnowledge.binding('operations')])
  expect((await f.ctx.cloudAgents.catalog()).capabilities).toMatchObject({ mcpTools: [], mcpServers: [],
    knowledgeSources: [{ id: 'operations', name: 'Operations', description: 'Approved evidence' }] })
  const usage = await f.ctx.cloudAgents.startSession({ id: record.id, releaseId }, new AbortController().signal)
  const agent = f.agents.get(usage.sessionId)!
  const evidence = { sourceId: 'operations', returned: 0, totalHits: 0, belowThreshold: 0, hits: [] }
  const search = vi.spyOn(f.ctx.companyKnowledge, 'search').mockResolvedValue(evidence)
  expect(await f.ctx.cloudAgents.searchKnowledge(agent, releaseId, 'operations', 'Question', new AbortController().signal)).toEqual(evidence)
  await expect(f.ctx.cloudAgents.searchKnowledge(agent, releaseId, 'foreign', 'Question', new AbortController().signal))
    .rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  expect(search).toHaveBeenCalledOnce()
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('available')
  await knowledgeFiber.dispose()
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('disabled')
  await f.ctx.plugin(Knowledge, KnowledgeConfig({ sources: [{ ...sources[0]!, spaceIds: ['changed'] }] }))
  expect((await f.ctx.cloudAgents.catalog()).usage[0]?.status).toBe('disabled')
  await expect(f.ctx.cloudAgents.validateCapabilities(releaseId)).rejects.toMatchObject({ code: 'company-knowledge/binding-changed' })
  await expect(f.ctx.cloudAgents.searchKnowledge(agent, releaseId, 'operations', 'Question', new AbortController().signal))
    .rejects.toMatchObject({ code: 'company-knowledge/binding-changed' })
})

it('refuses selected MCP tools when no MCP provider is mounted', async (test) => {
  const f = await fixture(test, undefined, [], false)
  const editor = await f.editor()
  await expect(f.ctx.cloudAgents.create(f.draft, editor)).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
})

it('reports unavailable MCP discovery in a knowledge-only deployment and validates saved capabilities in the service', async (test) => {
  const f = await fixture(test, undefined, [], false)
  const editor = await f.editor()
  const agent = f.agents.get(editor)!
  const tool = f.ctx.tools.get('cloud_agent')!
  const execution = { agent, callId: 'draft-no-mcp', signal: new AbortController().signal } as ToolRunContext
  await expect(tool.execute({ action: 'discover', serverId: 'sales' }, execution))
    .rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  await expect(tool.execute({ action: 'save', name: 'Sales', instructions: 'Use approved evidence.', mcpTools: ['mcp__sales__ping'] }, execution))
    .rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  await expect(tool.execute({ action: 'save', name: 'Knowledge only', instructions: 'Use approved evidence.' }, execution))
    .resolves.toContain('"action":"saved"')
})
