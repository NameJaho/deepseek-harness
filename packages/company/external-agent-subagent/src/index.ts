/** Optional Host-only external-platform subagent provider, with a Dify blocking adapter. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-agent'
import type { SubagentActivation, SubagentActivationSpec } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import * as DelegationTool from '@deepseek-ai/dsh-tool-subagent'
import { DifyAdapter, validUnicode } from './dify.ts'
import { failure } from './error.ts'
import { ExternalPlatformProvider } from './provider.ts'
import type { ExternalAgentDescriptor, ExternalAgentId, ExternalAgentRunDescriptor } from './types.ts'

export { ExternalAgentError } from './error.ts'
export type * from './types.ts'

/** Private deployment configuration for one separately registered logical agent. */
export interface ExternalAgentConfig {
  /** Deployment platform adapter; only `dify` is supported. */
  readonly platform: 'dify'
  /** Unique logical agent id; lowercase identifier starting with a letter. */
  readonly id: string
  /** Display name, at most 128 UTF-16 code units. */
  readonly name: string
  /** Deployment version descriptor; it does not select a remote app. */
  readonly version: string
  /** Deployment environment descriptor; it does not select a remote app. */
  readonly environment: string
  /** Unique subagent provider registry name the delegation tool selects. */
  readonly providerName: string
  /** Complete private POST URL ending in /chat-messages; HTTPS except loopback fixtures. */
  readonly endpoint: string
  /** Credential service reference, not a bearer token. */
  readonly credentialRef: string
  /** App input variables declared by its user_input_form; only explicit deployment values are sent. */
  readonly inputs: Readonly<Record<string, JsonValue>>
  /** Whole-call deadline, including credential resolution and response body consumption. */
  readonly timeoutMs: number
  /** Complete encoded request-body limit, including fixed protocol fields and configured inputs. */
  readonly maxInputBytes: number
  /** Decompressed HTTP response and serialized success result limit; failure diagnostics use the seam's 4096-byte limit. */
  readonly maxOutputBytes: number
  /** Permit explicit Host-only continuation of the latest successful owned child. */
  readonly allowContinuation: boolean
  /** Retention capacity per logical agent; admission fails instead of silently dropping descriptors. */
  readonly maxRetainedRuns: number
}

/** All agents are explicitly configured on the Host; an empty list enables no providers. */
export interface Config {
  /** Logical external agents; each registers one subagent provider. */
  readonly agents: ExternalAgentConfig[]
  /** Mount one ordinary delegation tool per logical agent; explicit scoped mounts may leave this disabled. */
  readonly registerTools?: boolean
}

const text = (): z<string> => z.string().min(1).max(128).required()
const positive = (): z<number> => z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required()

/** Configured input keys and string values must survive lossless UTF-8 encoding. */
function validInputStrings(value: JsonValue): boolean {
  if (typeof value === 'string') return validUnicode(value)
  if (value === null || typeof value !== 'object') return true
  if (Array.isArray(value)) return value.every(validInputStrings)
  return Object.entries(value).every(([key, item]) => validUnicode(key) && validInputStrings(item))
}

/** Resolve and validate deployment values before any provider registration. */
function resolve(config: Config): ExternalAgentConfig[] {
  const ids = new Set<string>()
  const providers = new Set<string>()
  const toolNames = new Set<string>()
  return config.agents.map((agent) => {
    for (const field of ['id', 'name', 'version', 'environment', 'providerName'] as const) {
      if (!validUnicode(agent[field]) || agent[field].trim().length === 0 || agent[field].length > 128) throw failure('configuration', 'not-sent')
    }
    if (!/^[a-z][a-z0-9._-]*$/.test(agent.id) || !/^[a-z][a-z0-9._-]*$/.test(agent.providerName)
      || ids.has(agent.id) || providers.has(agent.providerName)) throw failure('configuration', 'not-sent')
    ids.add(agent.id)
    providers.add(agent.providerName)
    const toolName = `subagent_external_${agent.id.replace(/[.-]/g, '_')}`
    if (config.registerTools === true && toolNames.has(toolName)) throw failure('configuration', 'not-sent')
    toolNames.add(toolName)
    for (const value of [agent.timeoutMs, agent.maxInputBytes, agent.maxOutputBytes, agent.maxRetainedRuns]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw failure('configuration', 'not-sent')
    }
    if (agent.timeoutMs > MAX_TIMER_DELAY_MS) throw failure('configuration', 'not-sent')
    let endpoint: URL
    try {
      endpoint = new URL(agent.endpoint)
      credentialRef(agent.credentialRef)
    } catch (error: unknown) {
      throw failure('configuration', 'not-sent', error)
    }
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)
    if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback))
      || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== ''
      || !endpoint.pathname.endsWith('/chat-messages')) throw failure('configuration', 'not-sent')
    const inputs = snapshotJsonValue(agent.inputs)
    if (inputs === undefined || !validInputStrings(inputs)) throw failure('configuration', 'not-sent')
    if (Buffer.byteLength(JSON.stringify(inputs), 'utf8') > agent.maxInputBytes) throw failure('configuration', 'not-sent')
    return { ...agent, endpoint: endpoint.href, inputs }
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-only external agent discovery and explicit continuation. No execution Remote is registered. */
    externalAgentSubagents: ExternalAgentSubagentProvider
  }
}

/** Registers swappable external backends on ctx.subagents; never inherits local capabilities. */
export class ExternalAgentSubagentProvider extends Service {
  static inject = ['subagents', 'credentials', 'agents']
  static Config: z<Config> = z.object({
    registerTools: z.boolean().default(false),
    agents: z.array(z.object({
      platform: z.const('dify').required(), id: text(), name: text(), version: text(), environment: text(), providerName: text(),
      endpoint: z.string().required(), credentialRef: z.string().required(),
      // Input-variable JSON is validated and detached in resolve(); no app-specific schema is guessed.
      inputs: z.dict(z.any()).required(),
      timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
      maxInputBytes: positive(), maxOutputBytes: positive(), maxRetainedRuns: positive(),
      allowContinuation: z.boolean().required(),
    })).required(),
  })
  private readonly providers = new Map<ExternalAgentId, ExternalPlatformProvider>()

  /** @param ctx - Host context with standard subagent, credential and Agent services.
   * @param config - explicit private deployments; validation precedes registrations.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'externalAgentSubagents')
    const agents = resolve(config)
    for (const agent of agents) {
      const id = brandString<ExternalAgentId>(agent.id)
      const descriptor: ExternalAgentDescriptor = {
        id, name: agent.name, version: agent.version, environment: agent.environment,
        platform: agent.platform, providerName: agent.providerName,
        continuationAllowed: agent.allowContinuation, status: 'configured',
      }
      const provider = new ExternalPlatformProvider(this.ctx, {
        descriptor, credentialRef: credentialRef(agent.credentialRef), timeoutMs: agent.timeoutMs,
        maxInputBytes: agent.maxInputBytes, maxOutputBytes: agent.maxOutputBytes, maxRetainedRuns: agent.maxRetainedRuns,
      }, new DifyAdapter(agent))
      this.providers.set(id, provider)
      this.ctx.effect(function* () {
        yield ctx.subagents.registerProvider(provider)
        yield () => provider.dispose()
      }, 'externalAgentSubagents: provider and transport')
      if (config.registerTools === true) ctx.plugin(DelegationTool, {
        provider: agent.providerName, toolName: `subagent_external_${agent.id.replace(/[.-]/g, '_')}`,
        maxDepth: 'provider-managed',
      })
    }
  }

  /** Read configured logical agents only; no endpoint, credential reference or inputs.
   * @returns immutable-by-convention logical descriptors.
   */
  catalog(): readonly ExternalAgentDescriptor[] {
    return [...this.providers.values()].map(provider => provider.describe())
  }

  /** Start through the standard logged carrier, optionally continuing an owned successful call.
   * @param agentId - configured logical agent, not a URL or platform id.
   * @param spec - normal managed activation request; provider is selected by agentId.
   * @param continuationOf - prior successful child's identity; absence starts fresh. Live-only and latest-child-only.
   * @returns managed activation with standard parent catalog and result delivery.
   */
  startActivation(agentId: ExternalAgentId, spec: Omit<SubagentActivationSpec, 'provider' | 'childId'>, continuationOf?: SessionId): Promise<SubagentActivation> {
    const provider = this.provider(agentId)
    const request = { ...spec.request, ...(continuationOf === undefined ? {} : { externalAgentContinuation: continuationOf }) }
    return this.ctx.subagents.startActivation({ ...spec, request, provider: provider.name })
  }

  /** Read execution facts under their exact live parent.
   * @param agentId - configured logical agent.
   * @param parent - exact original live parent.
   * @param childId - managed child's identity.
   * @returns safe retained input/output digests, status and structured failure.
   */
  describeRun(agentId: ExternalAgentId, parent: SubagentActivationSpec['request']['parent'], childId: SessionId): ExternalAgentRunDescriptor {
    return this.provider(agentId).describeRun(parent, childId)
  }

  /** Fail loud rather than silently choosing a different logical agent. */
  private provider(id: ExternalAgentId): ExternalPlatformProvider {
    const provider = this.providers.get(id)
    if (provider === undefined) throw failure('configuration', 'not-sent')
    return provider
  }
}

export default ExternalAgentSubagentProvider
