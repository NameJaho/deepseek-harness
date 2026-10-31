/** Declarative Agent capability sets, activation and session binding. */
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { bindScopeParent, createScope, scopeOf, scopeParentOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { dump } from 'js-yaml'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: the optional `settings` service this registry keeps off the generated pages.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-tools'
import type { AgentPresetDocument, AgentPresetRoster } from './types.ts'
import { entryListProblem, type PresetAvailability, type PresetDefinition } from './definition.ts'
import type { AgentPreset, Config } from './preset.ts'
import { agentPresetProjectionDefinition } from './session.ts'
import { auditRows, leakedServices, mountPreset, serviceForMount, type PresetMount } from './mount.ts'
import { activeCompositionModules, definitionComposition, mountedCompositionRows, type AgentPresetComposition, type AgentPresetInspection } from './composition-inventory.ts'

export { agentPresetProjectionDefinition } from './session.ts'
export { entryListProblem, type PresetAvailability, type PresetDefinition } from './definition.ts'
export { auditRows, leakedServices, type PresetMount, type RowAudit } from './mount.ts'
export type { AgentPresetInspection } from './composition-inventory.ts'
export type { AgentPreset, Config } from './preset.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresetRegistry
  }
}

interface Generation {
  scope: Scope
  key: ScopeKey
  mount: PresetMount
  availability: PresetAvailability
  users: number
  retired: boolean
}
interface Definition {
  config: PresetDefinition
  context: Context
  ready: Promise<void>
  generation?: Generation
  /** Mount failure; unset while a tree is mounted, whose rows {@link AgentPresetRegistry.diagnostic} re-audits on read. */
  broken?: string
}
interface Binding {
  parent: ScopeParentBinding
  generation: Generation
}

/** Registry of YAML-declared presets and the revisions live Agents retain. */
export class AgentPresetRegistry extends TypertRemoteService {
  static inject = ['loader', 'sessionProjections', 'agents']
  static Config = z.object({
    default: z.string().required(),
    selectedDefault: z.string().volatile(),
  })
  private agentPresetProjectionHandle!: ProjectionHandle<string | null>
  private readonly owner: Context
  private readonly definitions = new Map<string, Definition>()
  private readonly generations = new Map<ScopeKey, Generation>()
  private readonly bindings = new WeakMap<ScopeKey, Binding>()
  private readonly switches = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.owner = ctx
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.owner
    this.agentPresetProjectionHandle = await ctx.sessionProjections.register(agentPresetProjectionDefinition)
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'agent-preset/selected') ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /** Default preset for a subsequently created session. */
  get defaultId(): string { return this.config.selectedDefault.get() ?? this.config.default }

  /**
   * Read the preset recorded for a Session, including selections no longer in the roster.
   * @param session - Session whose committed preset selection is read.
   * @returns the recorded preset, or null when none was selected.
   */
  presetForSession(session: Session): string | null {
    return this.agentPresetProjectionHandle.stateOf(session)
  }

  /** Register and eagerly load a definition; activation failure remains visible in the roster.
   * @param definition Parsed configuration supplied by the declaring plugin.
   * @returns Definition disposer after activation or its diagnostic settles; the declaring plugin owns it.
   */
  async register(definition: PresetDefinition): Promise<() => Promise<void>> {
    const context = this.ctx
    if (!definition.id.trim()) throw new Error('Preset id must not be empty')
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
    const record: Definition = { config: definition, context, ready: Promise.resolve() }
    this.definitions.set(definition.id, record)
    let disposed = false
    const unregister = async (): Promise<void> => {
      if (disposed) return
      disposed = true
      this.definitions.delete(definition.id)
      await record.ready
      if (record.generation !== undefined) {
        record.generation.retired = true
        await this.collect(record.generation)
      }
    }
    record.ready = this.activate(record)
    await record.ready
    return unregister
  }

  private async activate(record: Definition): Promise<void> {
    const key = {}
    const scope = createScope(this.owner, key)
    try {
      const problem = entryListProblem(record.config.plugins)
      if (problem !== undefined) throw new Error(problem)
      const context = scope.ctx.extend({ baseUrl: record.context.baseUrl })
      const mount = await mountPreset(context, record.config.id, record.config.plugins)
      const generation: Generation = {
        scope,
        key,
        mount,
        availability: record.config.availability ?? 'selectable',
        users: 0,
        retired: false,
      }
      context.effect(() => {
        this.generations.set(key, generation)
        return () => { this.generations.delete(key) }
      }, 'agent-preset.mount')
      record.generation = generation
    } catch (error) {
      record.broken = (error as Error).message
      this.owner.logger.warn(`agent preset ${record.config.id}: ${record.broken}`)
      await scope.dispose()
    }
  }

  /**
   * Current activation diagnostic of a definition.
   *
   * A mount failure is final. A mounted tree is re-audited on every read: a
   * row waiting for a Host service activates by itself once that provider
   * finishes, so the audit waits for the Host Loader tree to settle before
   * reporting the row as unusable. Callers therefore must not run inside a
   * Host row's own activation, which the settlement would wait on.
   * @param record - the definition to audit.
   * @returns one line per unusable row, or undefined when the definition is usable.
   */
  private async diagnostic(record: Definition): Promise<string | undefined> {
    await record.ready
    if (record.generation === undefined) return record.broken
    const tree = record.generation.mount.tree
    let audit = await auditRows(tree)
    if (audit.pending.length > 0) {
      await this.owner.loader.await()
      audit = await auditRows(tree)
    }
    const lines = [...audit.failed, ...audit.pending]
    return lines.length === 0 ? undefined : lines.join('\n')
  }

  private async collect(generation: Generation): Promise<void> {
    if (!generation.retired || generation.users !== 0) return
    this.generations.delete(generation.key)
    await generation.scope.dispose()
  }

  private generationFor(ctx: Context): Generation | undefined {
    const key = scopeOf(ctx)
    const parent = key === undefined ? undefined : scopeParentOf(key)
    return parent === undefined ? undefined : this.generations.get(parent)
  }

  /** Inspect retained revisions, or the exact revision an Agent joined.
   * @param ctx - optional Agent context; omission includes all retained revisions.
   * @returns detached module references and isolation diagnostics; no match returns an empty list.
   */
  inspectCompositions(ctx?: Context): AgentPresetInspection[] {
    const joined = ctx === undefined ? undefined : this.generationFor(ctx)
    const generations = ctx === undefined ? [...this.generations.values()] : joined === undefined ? [] : [joined]
    return generations.map(({ mount }) => ({
      id: mount.presetId,
      modules: activeCompositionModules(mount.tree),
      leakedServices: leakedServices(this.owner, mount.fiber),
    }))
  }

  private selectable(record: Definition): boolean {
    return (record.config.availability ?? 'selectable') === 'selectable'
  }

  private selectableIds(): string[] {
    return [...this.definitions.values()]
      .filter(record => this.selectable(record))
      .map(record => record.config.id)
  }

  private definition(wanted: string, retained: boolean): Definition {
    const record = this.definitions.get(wanted)
    if (record === undefined || (!retained && !this.selectable(record))) throw this.notFound(wanted)
    return record
  }

  private notFound(wanted: string): RemoteError {
    return new RemoteError('agent-preset/not-found', `Unknown agent preset: ${wanted}`,
      { agentPreset: wanted, available: this.selectableIds() })
  }

  /** Read selectable presets, including their activation failures.
   * @returns Display metadata and loading diagnostics.
   */
  async list(): Promise<AgentPreset[]> {
    const rows = await Promise.all([...this.definitions.values()]
      .filter(record => this.selectable(record))
      .map(async (record) => {
        const broken = await this.diagnostic(record)
        return {
          id: record.config.id,
          ...(record.config.name === undefined ? {} : { name: record.config.name }),
          ...(record.config.description === undefined ? {} : { description: record.config.description }),
          ...(record.config.order === undefined ? {} : { order: record.config.order }),
          ...(broken === undefined ? {} : { broken }),
        }
      }))
    return rows.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.id.localeCompare(b.id))
  }

  /** Read the selection roster.
   * @returns Current selectable presets, each marked when it is the default.
   */
  @Remote('list')
  async remoteExportList(): Promise<AgentPresetRoster> {
    const defaultId = this.defaultId
    return { presets: (await this.list()).map(row => ({ ...row, isDefault: row.id === defaultId })) }
  }

  /** Read a declared identity's selection policy.
   * @param id Preset identity.
   * @returns Its normalized availability, or undefined when no definition is declared.
   */
  availabilityOf(id: string): PresetAvailability | undefined {
    const record = this.definitions.get(id)
    return record === undefined ? undefined : record.config.availability ?? 'selectable'
  }

  /** Resolve a selectable identity without starting an Agent.
   * @param id Explicit preset or the current default.
   * @returns Current metadata, including failure when activation failed.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const record = this.definition(wanted, false)
    const broken = await this.diagnostic(record)
    return { id: wanted, ...(broken === undefined ? {} : { broken }) }
  }

  /** Resolve an identity retained for exact Session restoration.
   * @param id Explicit durable preset identity.
   * @returns Current metadata, including failure when activation failed.
   */
  async resolveRetained(id: string): Promise<AgentPreset> {
    const record = this.definition(id, true)
    const broken = await this.diagnostic(record)
    return { id, ...(broken === undefined ? {} : { broken }) }
  }

  /** Read one selectable declaration's child plugin list as YAML, for viewing only.
   * @param agentPreset Preset identity.
   * @returns The declared composition beside its published metadata.
   */
  @Remote('read')
  readDocument(agentPreset: string): Promise<AgentPresetDocument> {
    const record = this.definitions.get(agentPreset)
    if (record === undefined || !this.selectable(record)) return Promise.reject(this.notFound(agentPreset))
    const { id, name, description, plugins } = record.config
    // The Loader's own dialect, so `!!js` conditions read as declared rather than as expression objects.
    const content = dump(plugins, { schema: entryListSchema, noRefs: true, lineWidth: -1 })
    return Promise.resolve({
      agentPreset: id, content, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }),
    })
  }

  private async retain(id: string | undefined, retained: boolean): Promise<Generation> {
    const wanted = id ?? this.defaultId
    while (true) {
      const record = this.definition(wanted, retained)
      const broken = await this.diagnostic(record)
      if (this.definitions.get(wanted) !== record) continue
      const generation = record.generation
      if (broken !== undefined || generation === undefined) {
        const reason = broken as string
        throw new RemoteError('agent-preset/invalid', reason, { agentPreset: wanted, reason })
      }
      generation.users++
      return generation
    }
  }

  private async bind(ctx: Context, generation: Generation): Promise<void> {
    const key = scopeOf(ctx)
    if (key === undefined) throw new Error('Agent preset binding requires a scoped context')
    const binding = this.bindings.get(key)
    if (binding?.generation === generation) return
    if (binding !== undefined) {
      binding.parent.rebind(generation.key)
      const old = binding.generation
      generation.users++
      binding.generation = generation
      old.users--
      await this.collect(old)
    } else this.join(ctx, key, generation)
  }

  private join(ctx: Context, key: ScopeKey, generation: Generation): void {
    const binding = { parent: bindScopeParent(key, generation.key), generation }
    generation.users++
    this.bindings.set(key, binding)
    ctx.effect(() => async () => {
      this.bindings.delete(key)
      binding.generation.users--
      await this.collect(binding.generation)
    }, 'agent-preset.binding')
  }

  private async mountGeneration(ctx: Context, id: string | undefined, retained: boolean): Promise<AgentPreset> {
    const generation = await this.retain(id, retained)
    try {
      await this.bind(ctx, generation)
      return { id: generation.mount.presetId }
    } finally {
      generation.users--
      await this.collect(generation)
    }
  }

  /** Bind an unpublished Agent to a selectable preset revision.
   * @param ctx Agent context from its setup callback.
   * @param id Requested preset, or the default.
   * @returns Bound preset identity.
   */
  mount(ctx: Context, id?: string): Promise<AgentPreset> {
    return this.mountGeneration(ctx, id, false)
  }

  /** Bind an unpublished Agent while restoring an exact durable preset identity.
   * @param ctx Agent context from its setup callback.
   * @param id Durable preset identity.
   * @returns Bound preset identity.
   */
  mountRetained(ctx: Context, id: string): Promise<AgentPreset> {
    return this.mountGeneration(ctx, id, true)
  }

  /** Join a child to the exact revision retained by its parent.
   * @param ctx Child Agent context.
   * @param parent Parent Agent context.
   * @returns Inherited preset id, or undefined in a preset-free composition.
   */
  composeFrom(ctx: Context, parent: Context): string | undefined {
    const generation = this.generationFor(parent)
    if (generation === undefined) {
      if (parent.get('agentPresets')?.composedPreset(parent) !== undefined) {
        throw new Error('Parent preset revision is unavailable')
      }
      return undefined
    }
    // A child has no existing binding, so this path has no asynchronous cleanup.
    const key = scopeOf(ctx)
    if (key === undefined) throw new Error('Child preset binding requires a scope')
    if (this.bindings.has(key)) throw new Error('Child already joined a preset')
    this.join(ctx, key, generation)
    return generation.mount.presetId
  }

  /** Read the preset a live Agent uses.
   * @param ctx Agent context.
   * @returns Its preset id, if bound.
   */
  composedPreset(ctx: Context): string | undefined { return this.generationFor(ctx)?.mount.presetId }

  /** Read a service supplied inside an Agent's isolated preset group.
   * @param agent Agent whose composition is queried.
   * @param name Cordis service name.
   * @returns The service, or undefined.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    const mount = this.generationFor(agent.ctx)?.mount
    return mount === undefined ? undefined : serviceForMount(this.owner, mount, name)
  }

  /** Rebind a blank Agent; the caller owns the blank-session check.
   * @param ctx Agent context.
   * @param id Requested preset.
   * @returns The bound identity.
   */
  async recompose(ctx: Context, id: string): Promise<AgentPreset> {
    const preset = await this.mount(ctx, id)
    try { this.owner.emit('tools/change') }
    catch (error) { this.owner.logger.warn(`Preset tools observer: ${String(error)}`) }
    return preset
  }

  /** Select a preset before a session starts its first turn. A Session whose
   * log records the preset and whose Agent runs its current revision keeps its
   * composition; nothing is logged or announced.
   * @param agent Target Agent.
   * @param agentPreset Requested identity.
   * @returns Committed preset identity.
   */
  @Remote('select')
  async select(agent: Agent, agentPreset: string): Promise<string> {
    const turn = (this.switches.get(agent.id) ?? Promise.resolve()).then(async () => {
      const boundary = this.owner.agents.turnBoundaryOf(agent.session)
      if (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0) {
        throw new RemoteError('agent-preset/locked', 'This session has already started', { sessionId: agent.id, agentPreset })
      }
      const running = this.generationFor(agent.ctx)
      if (running?.availability === 'retained') {
        throw new RemoteError('agent-preset/locked', 'This session restores a retained preset and cannot change it', {
          sessionId: agent.id,
          agentPreset,
        })
      }
      const current = this.definitions.get(agentPreset)?.generation
      if (current !== undefined && running === current
        && this.agentPresetProjectionHandle.stateOf(agent.session) === agentPreset) return agentPreset
      const preset = await this.recompose(agent.ctx, agentPreset)
      agent.session.append('agent-preset/selected', { agentPreset: preset.id })
      return preset.id
    })
    const guard = turn.catch(() => undefined)
    this.switches.set(agent.id, guard)
    try { return await turn } finally {
      if (this.switches.get(agent.id) === guard) this.switches.delete(agent.id)
    }
  }

  /** Read current registrations for cold transcript presentation.
   * @param id Preset identity or the default.
   * @returns A revision lease; dispose it after the scoped read completes.
   */
  async acquireScope(id?: string): Promise<{ key: ScopeKey } & AsyncDisposable> {
    const generation = await this.retain(id, true)
    let disposed = false
    return { key: generation.key, [Symbol.asyncDispose]: async () => {
      if (disposed) return
      disposed = true
      generation.users--
      await this.collect(generation)
    } }
  }

  /** Read plugin rows without creating an Agent.
   * @returns Current declaration metadata and activation states.
   */
  compositionInventory(): Promise<AgentPresetComposition[]> {
    return Promise.all([...this.definitions.values()].map(async (record) => {
      const { id, name, description } = record.config
      const broken = await this.diagnostic(record)
      const read = definitionComposition(record.config.plugins, () => { throw new Error('Inactive definition') })
      return { id, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }),
        isDefault: this.selectable(record) && id === this.defaultId,
        ...(broken === undefined ? {} : { broken }),
        rows: record.generation === undefined ? ('rows' in read ? read.rows : []) : mountedCompositionRows(record.generation.mount.tree) }
    }))
  }
}
export default AgentPresetRegistry
