/** Persistent Cloud Agent drafts, immutable MCP/Skill releases and private member conversations. */
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Service, type Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionLogOffset, type SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionForkPlacement, SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-company-mcp-provider'
import type {} from '@deepseek-ai/dsh-company-knowledge'
import type { CompanyKnowledgeBinding, CompanyKnowledgeSearchResult } from '@deepseek-ai/dsh-company-knowledge/types'
import type {} from '@deepseek-ai/dsh-company-wecom-auth'
import type { CompanyOwnerScope } from '@deepseek-ai/dsh-company-wecom-auth/types'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { Config } from './config.ts'
import { SessionWorkspaces } from './workspaces.ts'
import { cloudAgentDomain, cloudAgentBindingProjection, recoveredBinding, draftSchema } from './storage.ts'
import { capabilityCatalog, snapshotSkills, toolFingerprint, unavailableCapability } from './capabilities.ts'
import { registerAuthoringTool } from './authoring.ts'
import { isConversationalAuthoringPreset, registerAuthoringCommands } from './commands.ts'
import { cloudAgentCompaction } from './compaction.ts'
import { conversationFiles, conversationFilesProjection, readConversationFile } from './files.ts'
import { prepareReport } from './reports.ts'
import type { ConversationFilePage, ConversationFileReadRequest } from './files.ts'
import type {
  CloudAgentCatalog, CloudAgentConversation, CloudAgentDraft, CloudAgentId, CloudAgentOwnerId,
  CloudAgentRecord, CloudAgentRelease, CloudAgentReleaseId, CloudAgentRevisionRequest, CloudAgentPublishRequest,
  CloudAgentSession, CloudAgentStartRequest, CloudAgentUpdateRequest, CloudAgentReport, CloudAgentUsageEntry,
} from './types.ts'

export { Config } from './config.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Company Agent publication and release authorization. */
    cloudAgents: CloudAgentService
  }
}

function presetId(releaseId: string): string { return `cloud-agent-${releaseId}` }
function digest(value: object): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** Durable directory retaining exact releases and per-member Session ownership. */
export class CloudAgentService extends TypertRemoteService {
  static inject = ['storageDomain', 'agentPresets', 'agents', 'llm', 'sessionController', 'tools',
    'workspaceRegistry', 'sessionProjections', 'permissionPresets', 'sessionPersistence']
  static Config = Config
  private readonly config: Config
  private readonly ready: Promise<Domain<typeof cloudAgentDomain>>
  private domain: Domain<typeof cloudAgentDomain> | undefined
  private bindingProjection: ProjectionHandle<CloudAgentConversation | null> | undefined
  private filesProjection: ProjectionHandle<FileAttachmentRef[]> | undefined
  private readonly initialized: Promise<void>
  private readonly restored: Promise<void>
  private readonly releases = new Map<CloudAgentReleaseId, CloudAgentRelease>()
  private readonly unregister = new Map<CloudAgentReleaseId, () => Promise<void>>()
  private readonly handles = new Set<AgentHandle>()
  private readonly workspaces: SessionWorkspaces
  private readonly capabilityCalls = new Set<Promise<unknown>>()
  private readonly capabilityLifetime = new AbortController()
  private unregisterAuthoring: (() => Promise<void>) | undefined
  private chain: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined
  private stopping = false

  /** @param owner - persistent catalog, presets, Session and single MCP provider services.
   * @param config - private workspace root and publication bounds.
   */
  constructor(private readonly owner: Context, config: Config) {
    super(owner, 'cloudAgents', { namespace: 'cloudAgents' })
    this.config = Config(config)
    if (!isAbsolute(this.config.workspaceRoot)) throw new Error('cloud-agent workspaceRoot must be absolute')
    this.workspaces = new SessionWorkspaces(this.config.workspaceRoot)
    this.ready = owner.storageDomain.open(cloudAgentDomain)
    this.restored = this.restore()
    this.initialized = this.restored.catch(async (error: unknown) => {
      try { await this.close() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Cloud Agent startup and rollback failed', { cause: error })
      }
      throw error
    })
    owner.effect(() => () => this.close(), 'cloud-agent: retained releases and Sessions')
    owner.inject(['companyWecomAuth'], (authCtx) => {
      authCtx.companyWecomAuth.registerResourceProvider({
        defaultWorkspaceCommands: ['create-agent', 'publish-agent'],
        bindings: (principal) => {
          const ownerId = authCtx.companyWecomAuth.ownerScope(principal)
          const ids = [...this.domain?.table('conversations').entries() ?? []]
            .filter(([, item]) => item.deletedAt === undefined && (item.ownerId ?? 'local-owner') === ownerId).map(([id]) => id)
          const editors = [...new Set([...ids, ...authCtx.companyWecomAuth.defaultWorkspaceSessions(principal)])]
          return [...authCtx.companyWecomAuth.sessionBindings(ids), ...editors.map(id => ({
            resource: { kind: 'session' as const, id }, role: { name: 'company:agent-edit', resource: 'session' as const,
              actions: ['cloudAgents/catalog', 'cloudAgents/follow', 'cloudAgents/create', 'cloudAgents/update', 'cloudAgents/publish', 'cloudAgents/unpublish',
                'cloudAgents/preview', 'cloudAgents/clone', 'cloudAgents/delete', 'cloudAgents/startAuthoring',
                'cloudAgents/deleteUnboundAuthoringSessions', 'commands/execute'] as const },
            condition: ({ action, args }: { action: string; args?: Readonly<Record<string, unknown>> }) =>
              action !== 'commands/execute' || args === undefined
                || (typeof args.line === 'string' && /^\/(?:create-agent|publish-agent)(?:\s|$)/u.test(args.line))
                ? { kind: 'allow' as const } : { kind: 'deny' as const, reason: 'command-not-granted' },
          })), { resource: { kind: 'global' as const }, role: { name: 'company:agents', resource: 'global' as const,
            actions: ['cloudAgents/catalog', 'cloudAgents/follow', 'cloudAgents/startAuthoring', 'cloudAgents/startSession',
              'cloudAgents/deleteUnboundAuthoringSessions', 'cloudAgents/delete'] as const } }]
        },
        sessionOwner: (id) => {
          const item = this.domain?.table('conversations').get(id)
          return item === undefined ? undefined : brandString<CompanyOwnerScope>(item.ownerId ?? 'local-owner')
        },
      })
      authCtx.on('domain/changed', (change) => {
        if (change.domain === cloudAgentDomain.name) authCtx.get('remoteAccess')?.invalidate()
      })
    })
    // Ordinary selectable/default creation belongs to the Session controller, not this provider.
    owner.sessionController.registerCreationProvider(async (request, create, caller) => {
      if (request.agentPreset === undefined || !request.agentPreset.startsWith('cloud-agent-')) return create(request)
      await this.initialized
      const record = [...(await this.ready).table('agents').entries()].map(([, item]) => item)
        .find(item => item.publishedReleaseId !== null && presetId(item.publishedReleaseId) === request.agentPreset)
      if (record?.publishedReleaseId === undefined || record.publishedReleaseId === null || request.cwd !== undefined
        || request.workspaceId !== undefined || request.sessionId !== undefined) {
        throw new RemoteError('cloud-agent/not-published', 'Use the current Agent directory to start this release', { id: request.agentPreset })
      }
      const result = await caller.cloudAgents.startSession({ id: record.id, releaseId: record.publishedReleaseId },
        caller.invocation?.signal ?? new AbortController().signal)
      return { sessionId: result.sessionId, agentPreset: request.agentPreset }
    })
    registerAuthoringTool(owner, this)
    registerAuthoringCommands(owner, this)
    owner.effect(() => owner.permissionPresets.registerGuard((session, permission) => {
      const preset = owner.agentPresets.presetForSession(session)
      if (preset !== null && preset !== 'cloud-agent-authoring' && preset.startsWith('cloud-agent-')
        && permission !== 'read-only') {
        throw new RemoteError('cloud-agent/authoring-required', 'Usage conversations are read-only; open an editing conversation', {})
      }
    }), 'cloud-agent: release permission guard')
    owner.sessionController.registerForkPlacementProvider((source, childId) => this.forkPlacement(source, childId))
    owner.on('agent/created', async ({ agent }) => {
      await this.initialized
      if (this.bindingProjection === undefined) throw new Error('Cloud Agent binding projection is unavailable')
      await this.recoverConversation(agent.session.header, this.bindingProjection.stateOf(agent.session))
    })
    owner.on('agent/disposed', ({ agent }) => {
      for (const handle of this.handles) if (handle.agent === agent) this.handles.delete(handle)
    })
  }

  /** Publish the service only after restoring durable definitions. */
  async [Service.init](): Promise<void> { await this.initialized }

  private async restore(): Promise<void> {
    const domain = await this.ready
    this.domain = domain
    this.bindingProjection = await this.owner.sessionProjections.register(cloudAgentBindingProjection)
    this.filesProjection = await this.owner.sessionProjections.register(conversationFilesProjection)
    this.unregisterAuthoring = await this.owner.agentPresets.register({
      id: 'cloud-agent-authoring', name: 'Cloud Agent authoring', availability: 'retained',
      plugins: [{ name: '@deepseek-ai/dsh-company-cloud-agent-runtime', config: {
        mode: 'authoring', releaseId: 'authoring', instructions: 'Help the user refine reusable Agent requirements. '
          + 'Use cloud_agent catalog and save to preserve confirmed instructions and selected MCP tools, skills and knowledge sources. '
          + 'Exclude credentials and one-off results. Publication requires the user to confirm the saved revision and visibility with /publish-agent.',
      } }, cloudAgentCompaction()],
    })
    for (const [id, record] of domain.table('agents').entries()) {
      if (record.id !== id) throw new Error(`Cloud Agent record key does not match id: ${id}`)
      for (const release of record.releases) await this.register(release)
    }
    for (const [id, binding] of domain.table('conversations').entries()) {
      const record = binding.agentId === null ? undefined : domain.table('agents').get(binding.agentId)
      if (binding.sessionId !== id || (binding.agentId !== null && record === undefined)
        || (binding.releaseId !== undefined && !record?.releases.some(release => release.id === binding.releaseId))) {
        throw new Error(`Cloud Agent conversation references are invalid: ${id}`)
      }
    }
    for (const { header } of await this.owner.sessionPersistence.list()) {
      if (domain.table('conversations').get(header.id) !== undefined) continue
      if (!header.agentPreset?.startsWith('cloud-agent-')) continue
      await using handle = await this.owner.sessionPersistence.open(header.id, 'read')
      const events = (await handle.read()).events
      const restored = this.owner.sessionProjections.restore({}, events, SessionLogOffset(0), header, SessionLogOffset(0))
      await this.recoverConversation(header, recoveredBinding(restored.checkpoint.companyCloudAgentBinding?.val))
    }
  }

  private close(): Promise<void> {
    this.stopping = true
    this.capabilityLifetime.abort(new Error('Cloud Agent service stopped'))
    return this.closing ??= this.dispose()
  }
  private async dispose(): Promise<void> {
    await this.restored.catch((_startupError: unknown) => { /* Initialization reports the failure. */ })
    await this.chain
    const settled = await Promise.allSettled([...this.handles].map(handle => handle.dispose()))
    // Callers own tool failures, including the cancellation caused by shutdown.
    await Promise.allSettled([...this.capabilityCalls])
    const cleanup = await Promise.allSettled([...this.unregister.values()].map(stop => stop()))
    const final = await Promise.allSettled([
      ...this.unregisterAuthoring === undefined ? [] : [this.unregisterAuthoring()],
      this.ready.then(domain => domain.close(), () => undefined),
    ])
    const failures = [...settled, ...cleanup, ...final]
      .flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Cloud Agent teardown failed')
  }

  /** Read owned drafts, public-or-owned releases and private usage groups.
   * @returns authoritative credential-free directory and capability choices.
   */
  @Remote
  async catalog(): Promise<CloudAgentCatalog> {
    const ownerId = this.ownerId()
    await this.initialized
    const domain = await this.ready
    const all = [...domain.table('agents').entries()].map(([, record]) => record)
    const records = all.filter(record => record.deletedAt === undefined)
    const conversations = [...domain.table('conversations').entries()].map(([, item]) => item)
      .filter(item => item.deletedAt === undefined && (item.ownerId ?? 'local-owner') === ownerId
        && this.allowsSession(item.sessionId))
    const servers = (await this.owner.get('companyMcpProvider')?.catalog())?.servers ?? []
    const used = new Map<CloudAgentId, CloudAgentConversation>()
    for (const conversation of conversations) if (conversation.role === 'usage' && conversation.agentId !== null) {
      used.set(conversation.agentId, conversation)
    }
    const usage: CloudAgentUsageEntry[] = [...used].map(([agentId, binding]) => {
      const record = all.find(item => item.id === agentId)
      const bound = record?.releases.find(item => item.id === binding.releaseId)
      const release = record?.releases.find(item => item.id === record.publishedReleaseId)
      const status = record === undefined || record.deletedAt !== undefined ? 'deleted'
        : release === undefined ? 'withdrawn' : !this.visible(record, release, ownerId) ? 'access-lost'
          : (release.definition.mcpServers ?? []).some(id => !servers.some(server => server.id === id && server.enabled && server.status === 'available'))
            || (release.mcpBindings ?? []).some(tool => !servers.some(server => server.enabled && server.status === 'available'
              && server.tools.some(current => current.name === tool.name && current.fingerprint === tool.fingerprint))) ? 'disabled'
            : release.id !== binding.releaseId ? 'updated' : 'available'
      return { agentId, ownerId: record?.ownerId ?? brandString<CloudAgentOwnerId>('local-owner'),
        name: bound?.definition.name ?? 'Cloud Agent', status,
        ...(status === 'available' || status === 'updated') && release !== undefined && record !== undefined
          ? { release: this.directoryRelease(release, record.ownerId === ownerId) } : {} }
    })
    return { conversations, mine: records.filter(record => record.ownerId === ownerId).toSorted((a, b) => b.updatedAt - a.updatedAt),
      published: records.flatMap((record) => {
        const release = record.releases.find(item => item.id === record.publishedReleaseId)
        return release === undefined || !this.visible(record, release, ownerId) ? [] : [{ id: record.id, ownerId: record.ownerId,
          release: this.directoryRelease(release, record.ownerId === ownerId) }]
      }), usage, models: await this.ctx.sessionController.modelCatalog(),
      capabilities: await capabilityCatalog(this.owner, this.config.capabilityPreset) }
  }

  /** Follow committed directory and provider changes, coalescing slow readers.
   * @param signal - subscriber cancellation.
   * @returns initial and subsequent authoritative catalogs.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<CloudAgentCatalog> {
    this.ownerId()
    let changed = true
    let wake = Promise.withResolvers<void>()
    const notify = (): void => { changed = true; wake.resolve() }
    const stops = [this.owner.on('domain/changed', (change) => { if (change.domain === cloudAgentDomain.name) notify() }),
      this.owner.on('llm/adapters-updated', notify), this.owner.on('company-mcp/changed', notify), this.owner.on('tools/change', notify)]
    signal.addEventListener('abort', notify, { once: true })
    const aborted = (): boolean => signal.aborted
    try {
      while (!aborted()) {
        if (!changed) await wake.promise
        if (aborted()) return
        changed = false; wake = Promise.withResolvers<void>()
        yield await this.catalog()
      }
    } finally { for (const stop of stops) stop(); signal.removeEventListener('abort', notify) }
  }

  /** Create a private draft from a live authorized conversation.
   * @param draft - validated reusable fields.
   * @param authoringSessionId - owning live editor; omission rejects creation.
   * @returns committed record; no release is created.
   */
  @Remote({ resources: { session: (_draft, authoringSessionId) => authoringSessionId } })
  create(draft: CloudAgentDraft, authoringSessionId?: SessionId): Promise<CloudAgentRecord> {
    const ownerId = this.ownerId()
    const definition = this.parseDraft(draft)
    return this.serialize(async () => {
      const authorize = await this.requireAuthoring(authoringSessionId, null)
      const capture = await this.captureDraft(definition)
      const record = { ...this.newRecord(capture.draft, ownerId), ...capture, sourceSessionId: authoringSessionId,
        sourceThroughSeq: this.sourceSeq(authoringSessionId) }
      authorize()
      await (await this.ready).table('agents').put(record.id, record)
      await this.bindAuthoring(authoringSessionId, record)
      return record
    })
  }

  /** Save one conversation's reusable requirements with executor-call deduplication.
   * @param agent - live initiating Agent.
   * @param requestId - tool executor call identity.
   * @param draft - complete reusable definition.
   * @param id - existing draft; omission uses this conversation's draft.
   * @param expectedRevision - exact revision for replacing an existing draft.
   * @param createNew - request a separate draft; a bound editor must use another Session.
   * @returns committed record, including on an exact replay.
   */
  saveFromConversation(agent: Agent, requestId: string, draft: CloudAgentDraft,
    id?: CloudAgentId, expectedRevision?: number, createNew: boolean = false): Promise<CloudAgentRecord> {
    if (this.owner.agents.get(agent.id) !== agent) throw new RemoteError('cloud-agent/authoring-required', 'A live editing conversation is required', {})
    const ownerId = this.ownerId()
    const definition = this.parseDraft(draft)
    const key = `${agent.id}:${requestId}:${digest(definition)}`
    return this.serialize(async () => {
      const domain = await this.ready
      const records = [...domain.table('agents').entries()].map(([, record]) => record)
      const retried = records.find(record => record.ownerId === ownerId && record.lastAuthoringRequestId === key)
      if (retried !== undefined && retried.deletedAt === undefined) return retried
      const relatedId = domain.table('conversations').get(agent.id)?.agentId
      const related = records.find(record => record.id === relatedId || record.sourceSessionId === agent.id)
      if (createNew && related !== undefined) throw new RemoteError('cloud-agent/authoring-required', 'Start another editing conversation for a separate Agent', {})
      const wanted = id ?? related?.id
      const authorize = await this.requireAuthoring(agent.id, wanted ?? null)
      const current = wanted === undefined
        ? undefined
        : await this.requireRecord({ id: wanted, expectedRevision: expectedRevision ?? -1 }, ownerId)
      const capture = await this.captureDraft(definition)
      const record: CloudAgentRecord = { ...(current ?? this.newRecord(capture.draft, ownerId)), ...capture,
        revision: current === undefined ? 1 : current.revision + 1, updatedAt: Date.now(),
        sourceSessionId: agent.id, sourceThroughSeq: Math.max(0, agent.session.seq - 1), lastAuthoringRequestId: key }
      authorize()
      await domain.table('agents').put(record.id, record)
      await this.bindAuthoring(agent.id, record)
      return record
    })
  }

  /** Open an owner-private editor with a selectable creation preset.
   * @param request - optional owned draft, source Session, extraction prompt and selectable creation preset;
   * reuse returns a live matching editor.
   * @param signal - creation cancellation.
   * @returns ready Session identity; failed preparation rolls back its resources.
   */
  @Remote({ resources: { session: request => request.sourceSessionId } })
  startAuthoring(request: {
    readonly id?: CloudAgentId
    readonly sourceSessionId?: SessionId
    readonly prompt?: string
    readonly reuse?: boolean
    readonly creationPreset?: string
  }, signal: AbortSignal): Promise<{ readonly sessionId: SessionId }> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      signal.throwIfAborted()
      const domain = await this.ready
      const record = request.id === undefined ? undefined : domain.table('agents').get(request.id)
      if (request.id !== undefined && (record === undefined || record.deletedAt !== undefined || record.ownerId !== ownerId)) {
        throw new RemoteError('cloud-agent/not-found', 'Cloud Agent was not found', { id: request.id })
      }
      const creationPreset = await this.selectablePreset(request.creationPreset)
      if (request.reuse === true) {
        const editor = [...domain.table('conversations').entries()].map(([, item]) => item)
          .find(item => item.role === 'authoring' && item.deletedAt === undefined && item.agentId === (record?.id ?? null)
            && (item.ownerId ?? 'local-owner') === ownerId && item.creationPreset === creationPreset
            && this.owner.agents.get(item.sessionId) !== undefined)
        if (editor !== undefined) return { sessionId: editor.sessionId }
      }
      if (request.sourceSessionId !== undefined) this.requireSessionOwner(request.sourceSessionId, ownerId)
      const source = request.sourceSessionId === undefined
        ? undefined
        : await this.owner.sessionController.resolveAgent(request.sourceSessionId)
      if (source !== undefined && !('agent' in source)) throw new RemoteError('cloud-agent/invalid-input', 'The source conversation is unavailable', { reason: 'sourceSessionId' })
      const context = source !== undefined && 'agent' in source ? source.agent.session.deriveMessages()
        .filter(message => message.role === 'user' || message.role === 'assistant')
        .map(message => `${message.role}: ${message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')}`).join('\n\n') : undefined
      const model = (await this.owner.sessionController.modelCatalog()).default
      const sessionId = brandString<SessionId>(randomUUID())
      let workspace: Workspace | undefined
      let handle: AgentHandle | undefined
      try {
        const cwd = await this.workspaces.workspace(sessionId)
        workspace = await this.owner.workspaceRegistry.create(cwd, record?.draft.name ?? 'Cloud Agent')
        const binding: CloudAgentConversation = { sessionId, agentId: record?.id ?? null, role: 'authoring', ownerId, creationPreset }
        handle = await this.owner.agents.create({ sessionId, signal, meta: { cwd, agentPreset: creationPreset },
          agentOptions: { provider: model.provider, model: model.model }, setup: async (agentCtx, agent) => {
            await this.owner.agentPresets.mount(agentCtx, creationPreset)
            this.owner.permissionPresets.set(agent.session, 'workspace-write')
            agent.model.select({ provider: model.provider, model: model.model })
            agent.session.append('cloud-agent/binding', binding)
          } })
        await workspace.attachSession(sessionId)
        await domain.table('conversations').put(sessionId, binding)
        this.handles.add(handle)
        if (context !== undefined || request.prompt !== undefined) await this.ctx.sessionController.prompt({ sessionId,
          requestId: brandString<SessionPromptRequest['requestId']>(randomUUID()), mode: 'queue', content: [{ type: 'text',
            text: `${request.prompt ?? 'Extract confirmed reusable requirements and save an Agent draft. Do not publish.'}\n\n${context ?? ''}` }] }, signal)
        return { sessionId }
      } catch (error) { return this.rollbackSession(error, sessionId, workspace, handle) }
    })
  }

  /** Replace a draft without modifying any retained release.
   * @param request - owning editor, exact revision and complete new definition.
   * @returns next revision; stale writes preserve the current record.
   */
  @Remote({ resources: { session: request => request.authoringSessionId } })
  update(request: CloudAgentUpdateRequest): Promise<CloudAgentRecord> {
    const ownerId = this.ownerId()
    const draft = this.parseDraft(request.draft)
    return this.serialize(async () => {
      const authorize = await this.requireAuthoring(request.authoringSessionId, request.id)
      const record = await this.requireRecord(request, ownerId)
      const capture = await this.captureDraft(draft)
      const updated = { ...record, ...capture, revision: record.revision + 1, updatedAt: Date.now(),
        sourceSessionId: request.authoringSessionId, sourceThroughSeq: this.sourceSeq(request.authoringSessionId) }
      authorize()
      await (await this.ready).table('agents').put(record.id, updated)
      return updated
    })
  }

  /** Publish a confirmed revision and audience, deduplicating an exact publication replay.
   * @param request - owning editor, confirmed draft revision and public/private visibility; omission means public.
   * @returns the committed record; stale unrelated revisions fail without creating a release.
   */
  @Remote({ resources: { session: request => request.authoringSessionId } })
  publish(request: CloudAgentPublishRequest): Promise<CloudAgentRecord> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const authorize = await this.requireAuthoring(request.authoringSessionId, request.id)
      const current = (await this.ready).table('agents').get(request.id)
      const visibility = request.visibility ?? 'public'
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Remote JSON arguments are unvalidated at the wire boundary.
      if (visibility !== 'public' && visibility !== 'private') throw new RemoteError('cloud-agent/invalid-input', 'Choose public or private visibility', { reason: 'visibility' })
      const published = current?.releases.find(item => item.id === current.publishedReleaseId)
      if (current?.ownerId === ownerId && current.deletedAt === undefined && current.revision === request.expectedRevision + 1
        && published?.draftRevision === request.expectedRevision && (published.visibility ?? 'public') === visibility
        && published.source?.sessionId === request.authoringSessionId) { authorize(); return current }
      const record = await this.requireRecord(request, ownerId)
      return this.saveRelease(record, 'published', request.authoringSessionId, visibility, authorize)
    })
  }

  /** Withdraw publication while preserving existing private Sessions and releases.
   * @param request - owning editor and exact record revision.
   * @returns updated record.
   */
  @Remote({ resources: { session: request => request.authoringSessionId } })
  unpublish(request: CloudAgentRevisionRequest): Promise<CloudAgentRecord> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const authorize = await this.requireAuthoring(request.authoringSessionId, request.id)
      const record = await this.requireRecord(request, ownerId)
      const updated = { ...record, revision: record.revision + 1, publishedReleaseId: null, updatedAt: Date.now() }
      authorize()
      await (await this.ready).table('agents').put(record.id, updated)
      return updated
    })
  }

  /** Start an exact current public-or-owned release with only its pinned capabilities.
   * @param request - exact directory entry and optional selectable run preset and model override.
   * @param signal - creation cancellation.
   * @returns fresh owner-private ordinary Session.
   */
  @Remote
  startSession(request: CloudAgentStartRequest, signal: AbortSignal): Promise<CloudAgentSession> {
    const ownerId = this.ownerId()
    return this.serialize(async () => this.start(await this.publicRelease(request, ownerId), request, signal, ownerId))
  }

  /** Snapshot and test an owned draft without publishing it.
   * @param request - exact draft revision and live editor.
   * @param signal - creation cancellation.
   * @returns independent private Session pinned to a preview release.
   */
  @Remote({ resources: { session: request => request.authoringSessionId } })
  preview(request: CloudAgentRevisionRequest, signal: AbortSignal): Promise<CloudAgentSession> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const authorize = await this.requireAuthoring(request.authoringSessionId, request.id)
      const record = await this.requireRecord(request, ownerId)
      const updated = await this.saveRelease(record, 'preview', request.authoringSessionId, 'private', authorize)
      const release = updated.releases.at(-1)
      if (release === undefined) throw new Error('Preview committed without its release')
      return this.start(release, { id: record.id, releaseId: release.id }, signal, ownerId)
    })
  }

  /** Clone an accessible published release into a private editor-owned draft.
   * @param request - current directory release and authorized editor.
   * @returns independent record with no copied conversations.
   */
  @Remote({ resources: { session: request => request.authoringSessionId } })
  clone(request: CloudAgentStartRequest): Promise<CloudAgentRecord> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const authorize = await this.requireAuthoring(request.authoringSessionId, null)
      const release = await this.publicRelease(request, ownerId)
      const record = { ...this.newRecord(this.parseDraft(release.definition), ownerId),
        draftMcpBindings: release.mcpBindings ?? [], draftSkillSnapshots: release.skillSnapshots ?? [],
        draftCapabilityPreset: release.capabilityPreset, sourceSessionId: request.authoringSessionId,
        sourceThroughSeq: this.sourceSeq(request.authoringSessionId) }
      authorize()
      await (await this.ready).table('agents').put(record.id, record)
      await this.bindAuthoring(request.authoringSessionId, record)
      return record
    })
  }

  /** Tombstone an owned definition; immutable releases and usage Sessions remain private and recoverable.
   * @param request - owned Agent and exact revision.
   * @returns after the durable tombstone is committed.
   */
  @Remote
  delete(request: { readonly id: CloudAgentId; readonly expectedRevision: number }): Promise<void> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const record = await this.requireRecord(request, ownerId)
      const now = Date.now()
      await (await this.ready).table('agents').put(record.id, { ...record, revision: record.revision + 1,
        publishedReleaseId: null, deletedAt: now, updatedAt: now })
    })
  }

  /** Archive and remove only the caller's unsaved editors.
   * @param request - exact unbound editor Session identities.
   * @returns after archiving and removing private workspace registrations and files.
   */
  @Remote({ resources: { session: request => request.sessionIds } })
  deleteUnboundAuthoringSessions(request: { readonly sessionIds: readonly SessionId[] }): Promise<void> {
    const ownerId = this.ownerId()
    return this.serialize(async () => {
      const domain = await this.ready
      const bindings = [...new Set(request.sessionIds)].map((id) => {
        const item = domain.table('conversations').get(id)
        if (item === undefined || item.agentId !== null || item.role !== 'authoring' || (item.ownerId ?? 'local-owner') !== ownerId) {
          throw new RemoteError('cloud-agent/invalid-input', 'Only owned unsaved editing conversations can be deleted', { reason: 'sessionIds' })
        }
        return item
      })
      for (const binding of bindings) {
        await this.owner.workspaceRegistry.archiveSession(binding.sessionId, { stopActivity: true })
        const handle = [...this.handles].find(item => item.agent.id === binding.sessionId)
        await handle?.dispose()
        if (handle !== undefined) this.handles.delete(handle)
        for (const workspace of this.owner.workspaceRegistry.list().filter(item => item.sessionIds.includes(binding.sessionId))) {
          if (workspace.sessionIds.every(id => bindings.some(item => item.sessionId === id))) {
            await this.owner.workspaceRegistry.delete(workspace.id)
          }
        }
        await this.workspaces.discardWorkspace(binding.sessionId)
        await domain.table('conversations').put(binding.sessionId, { ...binding, deletedAt: Date.now() })
      }
    })
  }

  /** Check knowledge permissions, selected server enablement and every pinned MCP signature before execution.
   * @param releaseId - trusted immutable release identity.
   */
  async validateCapabilities(releaseId: string): Promise<void> {
    const release = this.releases.get(brandString<CloudAgentReleaseId>(releaseId))
    if (release === undefined) throw unavailableCapability(releaseId)
    for (const binding of release.knowledgeBindings ?? []) {
      const knowledge = this.owner.get('companyKnowledge')
      if (knowledge === undefined) throw unavailableCapability(binding.id)
      knowledge.validate(binding)
    }
    for (const id of release.definition.mcpServers ?? []) await this.mcpProvider().discoverTools(id)
    for (const binding of release.mcpBindings ?? []) {
      const current = await this.mcpProvider().resolveTool(binding.name)
      if (current === undefined || toolFingerprint(current.schema) !== binding.fingerprint) throw unavailableCapability(binding.name)
    }
  }

  /** Resolve signature-checked wrappers through the single execution provider.
   * @param releaseId - trusted release selected by the scoped runtime.
   * @returns release-only tools; every invocation rechecks authorization and current schema.
   */
  async releaseMcpTools(releaseId: string): Promise<readonly ToolDefinition[]> {
    const release = this.releases.get(brandString<CloudAgentReleaseId>(releaseId))
    if (release === undefined) throw unavailableCapability(releaseId)
    await this.validateCapabilities(releaseId)
    return Promise.all((release.mcpBindings ?? []).map(async (binding) => {
      const current = await this.mcpProvider().resolveTool(binding.name)
      if (current === undefined || toolFingerprint(current.schema) !== binding.fingerprint) throw unavailableCapability(binding.name)
      return { ...current.tool, execute: (args: unknown, execution: ToolRunContext): Promise<unknown> => {
        const run = async (): Promise<unknown> => {
          this.requireReleaseAgent(execution.agent, releaseId)
          await this.validateCapabilities(releaseId)
          const tool = await this.mcpProvider().resolveTool(binding.name)
          if (tool === undefined || toolFingerprint(tool.schema) !== binding.fingerprint) throw unavailableCapability(binding.name)
          this.requireReleaseAgent(execution.agent, releaseId)
          execution.signal.throwIfAborted()
          return tool.tool.execute(args, { ...execution, signal: AbortSignal.any([execution.signal, this.capabilityLifetime.signal]) })
        }
        return this.trackCapability(run())
      } }
    }))
  }

  /** Search one knowledge source approved by the invoking live release Session.
   * @param agent - trusted executor initiator.
   * @param releaseId - release compiled into the invoking runtime.
   * @param sourceId - logical source id; spaces and connection settings stay with the knowledge service.
   * @param query - natural-language question.
   * @param signal - tool cancellation.
   * @returns validated relevant passages; a source outside the release or with changed permissions is refused.
   */
  searchKnowledge(agent: Agent | undefined, releaseId: string, sourceId: string, query: string,
    signal: AbortSignal): Promise<CompanyKnowledgeSearchResult> {
    const run = async (): Promise<CompanyKnowledgeSearchResult> => {
      this.requireReleaseAgent(agent, releaseId)
      const binding = this.releases.get(brandString<CloudAgentReleaseId>(releaseId))?.knowledgeBindings?.find(item => item.id === sourceId)
      const knowledge = this.owner.get('companyKnowledge')
      if (binding === undefined || knowledge === undefined) throw unavailableCapability(sourceId)
      const result = await knowledge.search(binding, query, AbortSignal.any([signal, this.capabilityLifetime.signal]))
      this.requireReleaseAgent(agent, releaseId)
      return result
    }
    return this.trackCapability(run())
  }

  private trackCapability<T>(pending: Promise<T>): Promise<T> {
    this.capabilityCalls.add(pending)
    void pending.then(() => { this.capabilityCalls.delete(pending) }, () => { this.capabilityCalls.delete(pending) })
    return pending
  }

  /** List only attachments retained by the invoking live release Session.
   * @param agent - trusted executor initiator.
   * @returns recorded references, including compacted history.
   */
  conversationFiles(agent: Agent): FileAttachmentRef[] {
    const preset = this.owner.agentPresets.composedPreset(agent.ctx)
    this.requireReleaseAgent(agent, preset?.slice('cloud-agent-'.length) ?? '')
    if (this.filesProjection === undefined) throw new Error('Cloud Agent file projection is unavailable')
    return conversationFiles(this.filesProjection, agent.session)
  }

  /** Read a bounded verified page of this conversation's attachment.
   * @param agent - trusted live initiator.
   * @param request - attachment id and bounded text offset/limit.
   * @param signal - read cancellation.
   * @returns verified UTF-8 page; no arbitrary Host path is accepted.
   */
  readConversationFile(agent: Agent, request: ConversationFileReadRequest, signal: AbortSignal): Promise<ConversationFilePage> {
    const ref = this.conversationFiles(agent).find(file => file.attachmentId === request.attachmentId)
    const store = this.owner.get('attachments')
    if (ref === undefined) throw unavailableCapability('attachment')
    if (store === undefined) throw unavailableCapability('attachments')
    return readConversationFile(store, ref, request, this.config, signal)
  }

  /** Prepare a bounded report for persistence by the invoking tool pipeline.
   * @param agent - live release initiator.
   * @param name - plain filename.
   * @param content - complete report text.
   * @returns durable report metadata without a Host path.
   */
  conversationReport(agent: Agent, name: string, content: string): CloudAgentReport {
    this.conversationFiles(agent)
    return prepareReport(name, content, this.config.reportMaxBytes)
  }

  private requireReleaseAgent(agent: Agent | undefined, releaseId: string): void {
    if (this.stopping || agent === undefined || this.owner.agents.get(agent.id) !== agent
      || !this.releases.has(brandString<CloudAgentReleaseId>(releaseId))
      || agent.session.header.agentPreset !== presetId(releaseId)
      || this.owner.agentPresets.composedPreset(agent.ctx) !== presetId(releaseId)) throw unavailableCapability(releaseId)
  }

  private newRecord(draft: CloudAgentDraft, ownerId: CloudAgentOwnerId): CloudAgentRecord {
    const now = Date.now()
    return { id: brandString<CloudAgentId>(randomUUID()), ownerId, revision: 1, draft,
      releases: [], publishedReleaseId: null, createdAt: now, updatedAt: now }
  }
  private directoryRelease(release: CloudAgentRelease, owned: boolean): CloudAgentRelease {
    if (owned) return release
    const { source: _privateSource, ...publicRelease } = release
    return publicRelease
  }
  private visible(record: CloudAgentRecord, release: CloudAgentRelease, ownerId: CloudAgentOwnerId): boolean {
    return record.ownerId === ownerId || (release.visibility ?? 'public') === 'public'
  }
  private allowsSession(id: SessionId): boolean { return this.ctx.get('remoteAccess')?.allows({ kind: 'session', id }) ?? true }
  private requireSessionOwner(id: SessionId, ownerId: CloudAgentOwnerId): void {
    const company = this.owner.get('companyWecomAuth')?.sessionOwner(id)
    const binding = this.domain?.table('conversations').get(id)
    const actual = company ?? binding?.ownerId ?? (binding === undefined ? undefined : 'local-owner')
    if (!this.allowsSession(id) || (actual === undefined ? ownerId !== 'local-owner' : actual !== ownerId)) {
      throw new RemoteError('cloud-agent/owner-required', 'The conversation belongs to another account', {})
    }
  }
  private ownerId(): CloudAgentOwnerId {
    const auth = this.ctx.get('companyWecomAuth')
    if (auth !== undefined) return brandString<CloudAgentOwnerId>(auth.ownerScope())
    if (this.ctx.invocation !== undefined && this.ctx.invocation.peer.principal.kind !== 'owner') {
      throw new RemoteError('cloud-agent/owner-required', 'An authenticated company account is required', {})
    }
    return brandString<CloudAgentOwnerId>('local-owner')
  }
  private parseDraft(input: CloudAgentDraft): CloudAgentDraft {
    const parsed = draftSchema.safeParse(input)
    if (!parsed.success) throw new RemoteError('cloud-agent/invalid-input', 'Check the reusable Agent fields', { reason: parsed.error.message })
    return { ...parsed.data, mcpTools: [...new Set(parsed.data.mcpTools ?? [])].sort(),
      mcpServers: [...new Set(parsed.data.mcpServers ?? [])].sort(), skills: [...new Set(parsed.data.skills ?? [])].sort(),
      ...parsed.data.knowledgeSources === undefined ? {} : { knowledgeSources: [...new Set(parsed.data.knowledgeSources)].sort() } }
  }
  private async requireRecord(request: CloudAgentRevisionRequest, ownerId: CloudAgentOwnerId): Promise<CloudAgentRecord> {
    const record = (await this.ready).table('agents').get(request.id)
    if (record === undefined || record.deletedAt !== undefined || record.ownerId !== ownerId) {
      throw new RemoteError('cloud-agent/not-found', 'Cloud Agent was not found', { id: request.id })
    }
    if (record.revision !== request.expectedRevision) throw new RemoteError('cloud-agent/conflict',
      'The draft changed; reload before saving or confirming publication', { currentRevision: record.revision })
    return record
  }
  private async requireAuthoring(sessionId: SessionId | undefined, id?: CloudAgentId | null): Promise<() => void> {
    const ownerId = this.ownerId()
    if (sessionId === undefined) throw new RemoteError('cloud-agent/authoring-required', 'Open an editing conversation', {})
    this.requireSessionOwner(sessionId, ownerId)
    const resolved = await this.owner.sessionController.resolveAgent(sessionId)
    const agent = 'agent' in resolved ? resolved.agent : undefined
    const authorize = (): void => {
      if (agent === undefined || this.owner.agents.get(agent.id) !== agent) throw new RemoteError('cloud-agent/authoring-required', 'A live editing conversation is required', {})
      this.requireSessionOwner(sessionId, ownerId)
      const preset = this.owner.agentPresets.composedPreset(agent.ctx)
      const permission = this.owner.permissionPresets.current(agent.session)
      const binding = this.domain?.table('conversations').get(sessionId)
      const eligible = preset === 'cloud-agent-authoring' || isConversationalAuthoringPreset(this.owner, preset)
      if (!eligible || (permission !== 'workspace-write' && permission !== 'danger-full-access')
        || binding?.role === 'usage' || binding?.deletedAt !== undefined
        || (binding !== undefined && id !== undefined && binding.agentId !== id)) {
        throw new RemoteError('cloud-agent/authoring-required', 'Use an owned workspace-write editor for this Agent', {})
      }
    }
    authorize()
    return authorize
  }
  private async bindAuthoring(sessionId: SessionId | undefined, record: CloudAgentRecord): Promise<void> {
    if (sessionId === undefined) return
    const agent = this.owner.agents.get(sessionId)
    if (agent === undefined) throw new Error('Authorized editor was disposed before binding')
    const binding: CloudAgentConversation = { sessionId, agentId: record.id, role: 'authoring', ownerId: record.ownerId,
      creationPreset: this.owner.agentPresets.composedPreset(agent.ctx) }
    agent.session.append('cloud-agent/binding', binding)
    await (await this.ready).table('conversations').put(sessionId, binding)
  }
  private async recoverConversation(header: SessionHeader, recorded: CloudAgentConversation | null): Promise<void> {
    const domain = await this.ready
    if (domain.table('conversations').get(header.id) !== undefined || header.origin === 'subagent') return
    if (recorded !== null) {
      // Forked audit events retain the original owner, never the current directory publisher.
      const binding = { ...recorded, sessionId: header.id }
      await domain.table('conversations').put(header.id, binding)
      return
    }
    // Missing ownership evidence must not turn a member usage Session into a local-owned Session.
    if (header.agentPreset?.startsWith('cloud-agent-')) throw new RemoteError('cloud-agent/owner-required',
      'This Agent conversation has no retained ownership record; restore its catalog backup', {})
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new RemoteError('cloud-agent/unavailable', 'Cloud Agent service is stopping', {}))
    const result = this.chain.then(async () => {
      await this.initialized
      if (this.stopping) throw new RemoteError('cloud-agent/unavailable', 'Cloud Agent service is stopping', {})
      return operation()
    })
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
  private async selectablePreset(id?: string): Promise<string> {
    const wanted = id ?? this.owner.agentPresets.defaultId
    if (this.owner.agentPresets.availabilityOf(wanted) !== 'selectable') throw new RemoteError('cloud-agent/preset-unavailable',
      'Choose an available selectable mode preset', { id: wanted })
    const resolved = await this.owner.agentPresets.resolve(wanted)
    if (resolved.broken !== undefined) throw new RemoteError('cloud-agent/preset-unavailable', 'The chosen mode preset is unavailable', { id: wanted })
    return resolved.id
  }
  private async publicRelease(request: CloudAgentStartRequest, ownerId: CloudAgentOwnerId): Promise<CloudAgentRelease> {
    const record = (await this.ready).table('agents').get(request.id)
    const release = record?.deletedAt === undefined && record?.publishedReleaseId === request.releaseId
      ? record.releases.find(item => item.id === request.releaseId) : undefined
    if (record === undefined || release === undefined || !this.visible(record, release, ownerId)) {
      throw new RemoteError('cloud-agent/not-published', 'This release is no longer accessible; refresh the directory', { id: request.id })
    }
    return release
  }
  private async register(release: CloudAgentRelease): Promise<() => Promise<void>> {
    this.releases.set(release.id, release)
    try {
      const stop = await this.owner.agentPresets.register({ id: presetId(release.id), name: release.definition.name,
        description: release.definition.description, availability: 'retained', plugins: [{
          name: '@deepseek-ai/dsh-company-cloud-agent-runtime', config: { mode: 'release', releaseId: release.id,
            instructions: release.definition.instructions, mcpTools: release.definition.mcpTools ?? [],
            skills: release.skillSnapshots ?? [],
            knowledgeSources: (release.knowledgeBindings ?? []).map(binding => binding.id) },
        }, cloudAgentCompaction()] })
      this.unregister.set(release.id, stop)
      return stop
    } catch (error) { this.releases.delete(release.id); throw error }
  }
  private sourceSeq(sessionId: SessionId | undefined): number {
    const agent = sessionId === undefined ? undefined : this.owner.agents.get(sessionId)
    if (agent === undefined) throw new RemoteError('cloud-agent/authoring-required', 'The source editor is unavailable', {})
    return Math.max(0, agent.session.seq - 1)
  }
  private async captureDraft(draft: CloudAgentDraft): Promise<Pick<CloudAgentRecord,
    'draft' | 'draftMcpBindings' | 'draftSkillSnapshots' | 'draftCapabilityPreset'>> {
    const servers = await Promise.all((draft.mcpServers ?? []).map(id => this.mcpProvider().discoverTools(id)))
    const names = [...new Set([...(draft.mcpTools ?? []), ...servers.flat().map(tool => tool.name)])].sort()
    const definition = this.parseDraft({ ...draft, mcpTools: names })
    this.knowledgeBindings(definition)
    const draftMcpBindings = await Promise.all(names.map(async (name) => {
      const tool = await this.mcpProvider().resolveTool(name)
      if (tool === undefined) throw unavailableCapability(name)
      return { name, fingerprint: toolFingerprint(tool.schema) }
    }))
    return { draft: definition, draftMcpBindings,
      draftSkillSnapshots: await snapshotSkills(this.owner, draft.skills ?? [], this.config),
      draftCapabilityPreset: this.config.capabilityPreset }
  }
  private mcpProvider(): Context['companyMcpProvider'] {
    const provider = this.owner.get('companyMcpProvider')
    if (provider === undefined) throw unavailableCapability('MCP provider')
    return provider
  }
  private knowledgeBindings(definition: CloudAgentDraft): CompanyKnowledgeBinding[] {
    const knowledge = this.owner.get('companyKnowledge')
    return (definition.knowledgeSources ?? []).map((id) => {
      if (knowledge === undefined || !knowledge.sources().some(source => source.id === id)) throw unavailableCapability(id)
      return knowledge.binding(id)
    })
  }
  private async saveRelease(record: CloudAgentRecord, kind: CloudAgentRelease['kind'], sessionId: SessionId | undefined,
    visibility: 'public' | 'private', authorize: () => void): Promise<CloudAgentRecord> {
    const definition = this.parseDraft(record.draft)
    await this.owner.llm.resolveCallConfig({ provider: definition.provider, model: definition.model })
    if (record.draftMcpBindings === undefined || record.draftSkillSnapshots === undefined) {
      throw new RemoteError('cloud-agent/invalid-input', 'Save this draft to capture its capabilities before confirming publication', { reason: 'draft-snapshot-required' })
    }
    for (const id of definition.mcpServers ?? []) await this.mcpProvider().discoverTools(id)
    const mcpBindings = record.draftMcpBindings
    for (const binding of mcpBindings) {
      const tool = await this.mcpProvider().resolveTool(binding.name)
      if (tool === undefined || toolFingerprint(tool.schema) !== binding.fingerprint) throw unavailableCapability(binding.name)
    }
    const skillSnapshots = record.draftSkillSnapshots
    const knowledgeBindings = this.knowledgeBindings(definition)
    const agent = sessionId === undefined ? undefined : this.owner.agents.get(sessionId)
    if (agent === undefined) throw new RemoteError('cloud-agent/authoring-required', 'The source editor is unavailable', {})
    const source = { sessionId: agent.id, throughSeq: Math.max(0, agent.session.seq - 1),
      preset: this.owner.agentPresets.composedPreset(agent.ctx), permission: this.owner.permissionPresets.current(agent.session) }
    const captured = { definition, mcpBindings, skillSnapshots, capabilityPreset: record.draftCapabilityPreset,
      ...knowledgeBindings.length === 0 ? {} : { knowledgeBindings } }
    const release: CloudAgentRelease = { ...captured, id: brandString<CloudAgentReleaseId>(randomUUID()), kind,
      version: kind === 'published' ? record.releases.filter(item => item.kind === 'published').length + 1 : 0,
      draftRevision: record.revision, createdAt: Date.now(), visibility, source, digest: digest(captured) }
    const stop = await this.register(release)
    try {
      const preset = await this.owner.agentPresets.resolveRetained(presetId(release.id))
      if (preset.broken !== undefined) throw unavailableCapability(release.id)
      const updated = { ...record, revision: record.revision + 1, releases: [...record.releases, release],
        publishedReleaseId: kind === 'published' ? release.id : record.publishedReleaseId, updatedAt: Date.now() }
      authorize()
      await (await this.ready).table('agents').put(record.id, updated)
      return updated
    } catch (error) {
      this.unregister.delete(release.id); this.releases.delete(release.id)
      try { await stop() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Publication rollback failed', { cause: error }) }
      throw error
    }
  }
  private async start(release: CloudAgentRelease, request: CloudAgentStartRequest, signal: AbortSignal,
    ownerId: CloudAgentOwnerId): Promise<CloudAgentSession> {
    signal.throwIfAborted()
    const runPreset = await this.selectablePreset(request.runPreset)
    const provider = request.provider ?? release.definition.provider
    const model = request.model ?? release.definition.model
    await this.owner.llm.resolveCallConfig({ provider, model })
    const sessionId = brandString<SessionId>(randomUUID())
    const binding: CloudAgentConversation = { sessionId, agentId: request.id, role: 'usage', releaseId: release.id, ownerId,
      creationPreset: release.source?.preset, runPreset,
      effectiveDigest: digest({ release: release.digest ?? digest(release.definition), runPreset, provider, model, permission: 'read-only' }) }
    let handle: AgentHandle | undefined
    let workspace: Workspace | undefined
    try {
      await this.validateCapabilities(release.id)
      const cwd = await this.workspaces.workspace(sessionId)
      await this.workspaces.materializeSkills(sessionId, release.skillSnapshots ?? [])
      workspace = await this.owner.workspaceRegistry.create(cwd, release.definition.name)
      handle = await this.owner.agents.create({ sessionId, signal, meta: { cwd, agentPreset: presetId(release.id) },
        agentOptions: { provider, model }, setup: async (agentCtx, agent) => {
          // The selectable run mode is audited, never mounted with its unapproved tools or file capabilities.
          await this.owner.agentPresets.mountRetained(agentCtx, presetId(release.id))
          this.owner.permissionPresets.set(agent.session, 'read-only')
          agent.session.append('model/selection', { provider, model })
          agent.session.append('cloud-agent/binding', binding)
        } })
      await workspace.attachSession(sessionId)
      await (await this.ready).table('conversations').put(sessionId, binding)
    } catch (error) { return this.rollbackSession(error, sessionId, workspace, handle) }
    this.handles.add(handle)
    return { sessionId, releaseId: release.id }
  }
  private async forkPlacement(source: SessionHeader, childId: SessionId): Promise<SessionForkPlacement | undefined> {
    await this.initialized
    const binding = this.domain?.table('conversations').get(source.id)
    if (binding === undefined) return undefined
    // The Session controller authorizes the source before invoking this placement-only seam.
    // It carries no caller Context; ownership is copied from retained binding events, never inferred here.
    const release = binding.releaseId === undefined ? undefined : this.releases.get(binding.releaseId)
    if (binding.role === 'usage' && release === undefined) throw unavailableCapability(binding.releaseId ?? source.id)
    let workspace: Workspace | undefined
    try {
      const cwd = await this.workspaces.workspace(childId)
      if (release !== undefined) await this.workspaces.materializeSkills(childId, release.skillSnapshots ?? [])
      workspace = await this.owner.workspaceRegistry.create(cwd, release?.definition.name ?? 'Cloud Agent')
      const ownedWorkspace = workspace
      return { cwd, workspace, rollback: async () => {
        await this.rollbackSession(new Error('Fork creation failed'), childId, ownedWorkspace).catch((error: unknown) => {
          if (error instanceof AggregateError) throw error
        })
      } }
    } catch (error) { return this.rollbackSession(error, childId, workspace) }
  }
  private async rollbackSession(error: unknown, sessionId: SessionId, workspace?: Workspace, handle?: AgentHandle): Promise<never> {
    const failures: unknown[] = [error]
    try { await (await this.ready).table('conversations').delete(sessionId) } catch (cleanupError) { failures.push(cleanupError) }
    try { await handle?.dispose() } catch (cleanupError) { failures.push(cleanupError) }
    if (workspace !== undefined) {
      try { await this.owner.workspaceRegistry.delete(workspace.id) } catch (cleanupError) { failures.push(cleanupError) }
    }
    try { await this.workspaces.discardWorkspace(sessionId) } catch (cleanupError) { failures.push(cleanupError) }
    if (failures.length > 1) throw new AggregateError(failures, 'Session creation and rollback failed', { cause: error })
    throw error
  }
}

export default CloudAgentService
