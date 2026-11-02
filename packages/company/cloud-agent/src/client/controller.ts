/** One observable directory, serialized UI mutations and reconnecting catalog consumption. */
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudAgentCatalog, CloudAgentDraft, CloudAgentId, CloudAgentRecord, CloudAgentSession, CloudAgentStartRequest, CloudAgentVisibility } from '../types.ts'
import type { CloudAgentLocaleKey } from './locales.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-company-cloud-agent/remote'

/** Generated management methods the controller calls. */
export type CloudAgentControllerApi = Pick<ClientRemote['cloudAgents'], 'startAuthoring' | 'startSession' | 'publish' | 'unpublish'
  | 'delete' | 'preview' | 'clone' | 'create' | 'update'>
/** Catalog stream members the controller consumes. */
export type CloudAgentCatalogStream = Pick<RemoteStream<CloudAgentCatalog>, 'dispose' | typeof Symbol.asyncIterator>
type Api = CloudAgentControllerApi
type CatalogStream = CloudAgentCatalogStream
/** Outcome of saving an Agent draft or its model-facing plugin selections. */
export type CloudAgentSaveResult = CloudAgentRecord
  | { readonly conflictRevision: number }
  | { readonly authoringRequired: true }
  | undefined

/** Stable snapshot retained across panel navigation and query failures. */
export interface CloudAgentView {
  readonly catalog: CloudAgentCatalog | null
  readonly presets: readonly { readonly id: string; readonly name?: string; readonly broken?: string }[]
  readonly loading: boolean
  readonly error: CloudAgentLocaleKey | null
  readonly busy: boolean
  readonly notice: { readonly id: number; readonly key: CloudAgentLocaleKey; readonly success: boolean } | null
  readonly editorRequest: { readonly id: CloudAgentId; readonly sessionId: SessionId; readonly nonce: number } | null
}

/** Framework-injected source and actions; components never receive services. */
export interface CloudAgentInjected {
  readonly hooks: { readonly cloudAgent: HostObservable<CloudAgentView> }
  readonly refresh: () => Promise<void>
  readonly dismissNotice: () => void
  readonly prepareEditor: (id?: CloudAgentId, creationPreset?: string) => Promise<SessionId | undefined>
  readonly save: (
    id: CloudAgentId | null,
    revision: number,
    draft: CloudAgentDraft,
    authoringSessionId: SessionId,
  ) => Promise<CloudAgentSaveResult>
  /** Save only the Agent's model-facing plugin selections into its draft. */
  readonly saveCapabilities: (
    id: CloudAgentId,
    revision: number,
    capabilities: Pick<CloudAgentDraft, 'mcpTools' | 'mcpServers' | 'skills' | 'knowledgeSources'>,
    authoringSessionId: SessionId,
  ) => Promise<CloudAgentSaveResult>
  readonly publish: (record: CloudAgentRecord, authoringSessionId?: SessionId, visibility?: CloudAgentVisibility) => Promise<boolean>
  readonly unpublish: (record: CloudAgentRecord, authoringSessionId?: SessionId) => Promise<void>
  readonly deleteAgent: (record: CloudAgentRecord) => Promise<boolean>
  readonly preview: (record: CloudAgentRecord, authoringSessionId?: SessionId) => Promise<void>
  readonly start: (id: CloudAgentId, releaseId: CloudAgentSession['releaseId'], options?: Pick<CloudAgentStartRequest, 'runPreset' | 'provider' | 'model'>) => Promise<void>
  readonly clone: (id: CloudAgentId, releaseId: CloudAgentSession['releaseId']) => Promise<void>
  readonly createInChat: (id?: CloudAgentId, creationPreset?: string) => Promise<void>
  readonly fromConversation: (sessionId: SessionId) => Promise<void>
  readonly manage: (id?: CloudAgentId) => void
  readonly openConversation: (sessionId: SessionId) => void
  readonly closeEditor: () => void
}

/** Product failures are localized without rendering raw provider or transport diagnostics. */
function errorKey(error: unknown): CloudAgentLocaleKey {
  const failure = remoteErrorOf(error)
  switch (failure?.code) {
    case 'cloud-agent/conflict': return 'conflict'
    case 'cloud-agent/not-published': return 'notPublished'
    case 'cloud-agent/invalid-input': return 'invalid'
    case 'cloud-agent/authoring-required': return 'authoringRequired'
    case 'cloud-agent/owner-required': return 'denied'
    case 'cloud-agent/preset-unavailable': return 'presetUnavailable'
    case 'session/model-unavailable': return 'modelUnavailable'
    case 'cloud-agent/capability-unavailable': return 'capabilityUnavailable'
    default: return 'failed'
  }
}

/** Owns one catalog stream; late work cannot publish into a replacement lifecycle. */
export class CloudAgentController {
  private snapshot: CloudAgentView = {
    catalog: null, presets: [], loading: true, error: null, busy: false, notice: null, editorRequest: null,
  }
  private readonly listeners = new Set<() => void>()
  private stream: CatalogStream | undefined
  private pump: Promise<void> = Promise.resolve()
  private mutation: Promise<void> = Promise.resolve()
  private refreshWork: Promise<void> = Promise.resolve()
  private epoch = 0
  private disposed = false
  private refreshing = false
  private noticeId = 0
  private editorNonce = 0
  private readonly editors = new Map<CloudAgentId, SessionId>()

  /**
   * @param api - generated management methods.
   * @param makeStream - shared Gateway supervision for a catalog stream.
   * @param openSession - navigation after acknowledged session creation.
   * @param startConversation - normal Workspace conversation flow with Host-selected defaults.
   * @param authorFromChat - queue creation in the current Session; false means no request was queued.
   * @param openManager - navigate to the Cloud Agent directory.
   */
  constructor(
    private readonly api: Api,
    private readonly makeStream: () => CatalogStream,
    private readonly openSession: (session: Pick<CloudAgentSession, 'sessionId'>) => void,
    private readonly startConversation: () => void,
    private readonly authorFromChat: (sessionId: SessionId) => Promise<boolean>,
    private readonly openManager: () => void,
    private readonly loadPresets: () => Promise<CloudAgentView['presets']>,
  ) {}

  /** Stable source snapshot read by framework-bound hooks. */
  getSnapshot = (): CloudAgentView => this.snapshot

  /**
   * Observe source changes; one listener failure cannot starve other views.
   * @param listener - framework subscriber.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Replace a failed stream while retaining the last confirmed catalog.
   * @returns after the replacement consumer has been started.
   */
  refresh = (): Promise<void> => {
    if (this.disposed || this.refreshing) return Promise.resolve()
    this.refreshing = true
    const pending = this.performRefresh()
    this.refreshWork = pending
    return pending
  }

  private async performRefresh(): Promise<void> {
    const epoch = ++this.epoch
    this.set({ loading: true, error: null })
    try {
      await this.stream?.dispose()
      await this.pump
      if (!this.current(epoch)) return
      const presets = await this.loadPresets()
      if (!this.current(epoch)) return
      this.set({ presets })
      const stream = this.makeStream()
      this.stream = stream
      this.pump = this.consume(stream, epoch)
    } catch (_readError: unknown) {
      if (this.current(epoch)) this.set({ loading: false, error: 'readFailed' })
    } finally {
      this.refreshing = false
    }
  }

  /** Stop the stream before releasing its registering plugin. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.epoch++
    await this.stream?.dispose()
    await Promise.all([this.pump, this.mutation, this.refreshWork])
    this.editors.clear()
    this.listeners.clear()
  }

  /** Hide a completed-operation notice. */
  dismissNotice = (): void => { this.set({ notice: null }) }

  /** Report a companion management operation in the shared shell toast.
   * @param key - localized operation outcome.
   * @param success - whether the operation completed.
   */
  reportNotice = (key: CloudAgentLocaleKey, success: boolean): void => {
    this.set({ notice: { id: ++this.noticeId, key, success } })
  }

  /** Start the current publication or open an owned unpublished draft in its editor.
   * @param id - stable identity selected from the catalog.
   * @returns whether a session was acknowledged and opened.
   */
  connectToWorkspace = async (id: CloudAgentId): Promise<boolean> => {
    const catalog = this.snapshot.catalog
    const mine = catalog?.mine.find(record => record.id === id)
    const releaseId = catalog?.published.find(entry => entry.id === id)?.release.id ?? mine?.publishedReleaseId
    if (mine === undefined && releaseId == null) {
      this.reportNotice('notPublished', false)
      return false
    }
    const result = await this.mutate(() => releaseId == null
      ? this.api.startAuthoring({ id, reuse: true })
      : this.api.startSession({ id, releaseId }))
    if (result === undefined) return false
    this.openSession(result)
    return true
  }

  /** Start through capability-owned navigation without opening or reassigning an existing Session.
   * @param id - stable Agent identity.
   * @returns acknowledged new Session, or rejection when unavailable or another operation is pending.
   */
  startGroupedSession = async (id: CloudAgentId): Promise<SessionId> => {
    const catalog = this.snapshot.catalog
    const usage = catalog?.usage.find(item => item.agentId === id)
    const mine = catalog?.mine.find(item => item.id === id && item.deletedAt === undefined)
    const previous = catalog?.conversations.filter(item => item.agentId === id && item.role === 'usage' && item.deletedAt === undefined).at(-1)
    const release = usage?.release ?? mine?.releases.find(item => item.id === mine.publishedReleaseId)
    if (usage !== undefined && (usage.status !== 'available' && usage.status !== 'updated' || release === undefined)) {
      this.reportNotice('notPublished', false)
      throw new Error('Agent group is unavailable')
    }
    const result = await this.mutate(() => release === undefined && mine !== undefined
      ? this.api.startAuthoring({ id, ...previous?.creationPreset === undefined ? {} : { creationPreset: previous.creationPreset } })
      : release !== undefined ? this.api.startSession({ id, releaseId: release.id, runPreset: previous?.runPreset })
        : Promise.reject(new Error('Agent group is unavailable')))
    if (result === undefined) throw new Error('Agent conversation was not started')
    return result.sessionId
  }

  /**
   * Build the narrow component action face once at registration.
   * @returns source, mutation callbacks and navigation actions.
   */
  face(): CloudAgentInjected {
    return {
      hooks: { cloudAgent: this }, refresh: this.refresh, dismissNotice: this.dismissNotice,
      prepareEditor: (id, creationPreset) => this.prepareEditor(id, creationPreset),
      save: (id, revision, draft, sessionId) => this.saveDraft(id, revision, draft, sessionId),
      saveCapabilities: (id, revision, capabilities, sessionId) => {
        const record = this.snapshot.catalog?.mine.find(item => item.id === id)
        if (record === undefined) {
          this.reportNotice('failed', false)
          return Promise.resolve(undefined)
        }
        return this.saveDraft(id, revision, { ...record.draft, ...capabilities }, sessionId)
      },
      publish: async (record, sessionId, visibility) => {
        const result = await this.mutate(async () => this.api.publish({ id: record.id, expectedRevision: record.revision,
          authoringSessionId: sessionId ?? await this.editor(record.id), visibility }), 'publishedNotice')
        return result !== undefined
      },
      unpublish: async (record, sessionId) => {
        await this.mutate(async () => this.api.unpublish({ id: record.id, expectedRevision: record.revision,
          authoringSessionId: sessionId ?? await this.editor(record.id) }), 'unpublishedNotice')
      },
      deleteAgent: async (record) => {
        const deleted = await this.mutate(async () => {
          const result = await this.api.delete({ id: record.id, expectedRevision: record.revision })
          return result.ok ? { ok: true, value: true } : result
        }, 'deletedNotice')
        if (deleted !== true) return false
        this.editors.delete(record.id)
        if (this.snapshot.editorRequest?.id === record.id) this.set({ editorRequest: null })
        return true
      },
      preview: async (record, sessionId) => {
        const result = await this.mutate(async () => this.api.preview({ id: record.id, expectedRevision: record.revision,
          authoringSessionId: sessionId ?? await this.editor(record.id) }))
        if (result !== undefined) this.openSession(result)
      },
      start: async (id, releaseId, options) => {
        const result = await this.mutate(() => this.api.startSession({ id, releaseId, ...options }))
        if (result !== undefined) this.openSession(result)
      },
      clone: async (id, releaseId) => {
        const result = await this.mutate(async () => {
          const authoringSessionId = await this.editor()
          const result = await this.api.clone({ id, releaseId, authoringSessionId })
          if (!result.ok) return result
          if (!this.disposed) this.editors.set(result.value.id, authoringSessionId)
          return { ok: true as const, value: { record: result.value, sessionId: authoringSessionId } }
        }, 'clonedNotice')
        if (result !== undefined && !this.disposed) this.openSession({ sessionId: result.sessionId })
      },
      createInChat: async (id, creationPreset) => {
        if (id === undefined && creationPreset === undefined) {
          if (!this.disposed && !this.snapshot.busy) this.startConversation()
          return
        }
        const result = await this.mutate(() => this.api.startAuthoring({
          ...id === undefined ? {} : { id, reuse: true }, ...creationPreset === undefined ? {} : { creationPreset },
        }))
        if (result !== undefined) this.openSession(result)
      },
      fromConversation: async (sessionId) => {
        const conversation = this.snapshot.catalog?.conversations.find(item => item.sessionId === sessionId)
        if (conversation?.agentId !== null && conversation?.agentId !== undefined) {
          const target = await this.prepareEditor(conversation.agentId)
          if (target !== undefined) this.openSession({ sessionId: target })
          return
        }
        if (this.disposed || this.snapshot.busy) return
        this.set({ busy: true })
        const pending = this.authorFromChat(sessionId).then((accepted) => {
          if (!accepted) this.reportNotice('creationNotQueued', false)
        }).catch((error: unknown) => {
          this.set({ notice: { id: ++this.noticeId, key: errorKey(error), success: false } })
        }).finally(() => { this.set({ busy: false }) })
        this.mutation = pending
        await pending
      },
      manage: (id) => {
        if (id !== undefined) void this.prepareEditor(id).then((sessionId) => {
          if (sessionId !== undefined) this.set({ editorRequest: { id, sessionId, nonce: ++this.editorNonce } })
        })
        this.openManager()
      },
      openConversation: (sessionId) => { this.openSession({ sessionId }) },
      closeEditor: () => { this.set({ editorRequest: null }) },
    }
  }

  private prepareEditor(id?: CloudAgentId, creationPreset?: string): Promise<SessionId | undefined> {
    return this.mutate(async () => {
      if (id !== undefined) this.editors.delete(id)
      return { ok: true, value: await this.editor(id, creationPreset) }
    })
  }

  private async editor(id?: CloudAgentId, creationPreset?: string): Promise<SessionId> {
    const existing = id === undefined ? undefined : this.editors.get(id)
    if (existing !== undefined) return existing
    const result = await this.api.startAuthoring({
      ...id === undefined ? {} : { id },
      ...creationPreset === undefined ? {} : { creationPreset },
    })
    if (this.disposed) throw new Error('Agent editor lifecycle ended')
    if (!result.ok) throw result.error
    if (id !== undefined) this.editors.set(id, result.value.sessionId)
    return result.value.sessionId
  }

  private set(patch: Partial<CloudAgentView>): void {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    notifySubscribers(this.listeners, 'cloud-agent')
  }

  private current(epoch: number): boolean { return !this.disposed && epoch === this.epoch }

  private async consume(stream: CatalogStream, epoch: number): Promise<void> {
    try {
      for await (const item of stream) {
        if (this.disposed || epoch !== this.epoch) return
        this.set({ catalog: item.value, loading: false, error: null })
        item.accept()
      }
      if (this.current(epoch)) this.set({ loading: false, error: 'readFailed' })
    } catch (_streamError: unknown) {
      if (!this.disposed && epoch === this.epoch) this.set({ loading: false, error: 'readFailed' })
    }
  }

  private saveDraft(
    id: CloudAgentId | null,
    revision: number,
    draft: CloudAgentDraft,
    authoringSessionId: SessionId,
  ): Promise<CloudAgentSaveResult> {
    if (this.disposed || this.snapshot.busy) return Promise.resolve(undefined)
    this.set({ busy: true })
    const pending = this.performSave(id, revision, draft, authoringSessionId)
    this.mutation = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async performSave(
    id: CloudAgentId | null,
    revision: number,
    draft: CloudAgentDraft,
    authoringSessionId: SessionId,
  ): Promise<CloudAgentSaveResult> {
    try {
      const result = await (id === null
        ? this.api.create(draft, authoringSessionId)
        : this.api.update({ id, expectedRevision: revision, draft, authoringSessionId }))
      if (this.disposed) return undefined
      if (!result.ok) {
        const failure = remoteErrorOf(result.error)
        this.set({ notice: { id: ++this.noticeId, key: errorKey(result.error), success: false } })
        return failure?.code === 'cloud-agent/conflict'
          ? { conflictRevision: failure.details.currentRevision }
          : failure?.code === 'cloud-agent/authoring-required' ? { authoringRequired: true } : undefined
      }
      this.set({ notice: { id: ++this.noticeId, key: 'saved', success: true } })
      this.editors.set(result.value.id, authoringSessionId)
      return result.value
    } catch (error) {
      if (!this.disposed) this.set({ notice: { id: ++this.noticeId, key: errorKey(error), success: false } })
      return remoteErrorOf(error)?.code === 'cloud-agent/authoring-required' ? { authoringRequired: true } : undefined
    } finally {
      this.set({ busy: false })
    }
  }

  private mutate<T>(operation: () => Promise<RemoteResult<T>>, success?: CloudAgentLocaleKey): Promise<T | undefined> {
    if (this.disposed || this.snapshot.busy) return Promise.resolve(undefined)
    this.set({ busy: true })
    const pending = this.performMutation(operation, success)
    this.mutation = pending.then(() => undefined, () => undefined)
    return pending
  }

  private async performMutation<T>(
    operation: () => Promise<RemoteResult<T>>,
    success?: CloudAgentLocaleKey,
  ): Promise<T | undefined> {
    try {
      const result = await operation()
      if (this.disposed) return undefined
      if (!result.ok) {
        this.set({ notice: { id: ++this.noticeId, key: errorKey(result.error), success: false } })
        return undefined
      }
      if (success !== undefined) this.set({ notice: { id: ++this.noticeId, key: success, success: true } })
      return result.value
    } catch (error) {
      if (!this.disposed) this.set({ notice: { id: ++this.noticeId, key: errorKey(error), success: false } })
      return undefined
    } finally {
      this.set({ busy: false })
    }
  }
}
