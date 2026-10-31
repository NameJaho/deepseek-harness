/** Owned HTTP fixture and real parent/session registries for external provider tests. */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { onTestFinished } from 'vitest'
import ExternalAgents, { type ExternalAgentConfig } from '../src/index.ts'

export const ANSWER = { event: 'message', mode: 'chat', answer: '已完成 focused answer', conversation_id: 'conversation-one', message_id: 'message-one' }

export interface HttpRequest {
  readonly body: Record<string, unknown>
  readonly raw: string
  readonly headers: IncomingMessage['headers']
  readonly method: string | undefined
  readonly url: string | undefined
}

export async function httpFixture(handler: (response: ServerResponse, request: HttpRequest, index: number) => void = (res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(ANSWER))
}) {
  const requests: HttpRequest[] = []
  const received = Promise.withResolvers<HttpRequest>()
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const request = { raw, body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers, method: req.method, url: req.url }
      requests.push(request)
      received.resolve(request)
      handler(res, request, requests.length)
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    const closed = once(server, 'close')
    server.closeAllConnections()
    server.close()
    await closed
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture requires an assigned TCP port')
  return { endpoint: `http://127.0.0.1:${address.port}/v1/chat-messages`, requests, received: received.promise }
}

export function agentConfig(endpoint: string, overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    platform: 'dify', id: 'research', name: 'Research agent', version: 'release-1', environment: 'test', providerName: 'external-research',
    endpoint, credentialRef: 'DIFY_TEST_KEY', inputs: { language: 'zh' }, timeoutMs: 10_000,
    maxInputBytes: 4096, maxOutputBytes: 4096, maxRetainedRuns: 50, allowContinuation: true, ...overrides,
  }
}

export class FixtureCredentials extends Service {
  constructor(ctx: Context, private readonly config: { resolve: (ref: CredentialRef) => Promise<ResolvedCredential | undefined> }) { super(ctx, 'credentials') }
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> { return this.config.resolve(ref) }
}

export class FixtureDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  get(session: Session): string { return session.header.cwd ?? process.cwd() }
  ensure(agent: Agent, signal?: AbortSignal): Promise<string> { signal?.throwIfAborted(); return Promise.resolve(this.get(agent.session)) }
}

export async function registries(ctx: Context): Promise<void> {
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FixtureDirectory)
  await ctx.plugin(SubagentRuntime)
}

export async function parentAgent(ctx: Context): Promise<Agent> {
  const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd: process.cwd() } })
  const inbox = createInboxStub()
  const parent: Agent = {
    id: session.id, session, ctx, options: {}, status: 'idle', model: unsupportedModel(), inbox,
    send: (message, target) => { inbox.append(target, message) },
    followup: (message) => { inbox.append('next-turn', message) },
    steer: (message) => { inbox.append('next-step', message) },
    inject: (message) => { inbox.append('next-step', message) },
    cancel: (_cause, options) => { if (!options?.keepInbox) inbox.clear() },
    whenIdle: () => Promise.resolve(), runMaintenance: task => task(new AbortController().signal),
  }
  await ctx.agents.register(parent)
  return parent
}

export async function setup(config: ExternalAgentConfig, resolve: (ref: CredentialRef) => Promise<ResolvedCredential | undefined> = async () => ({ value: 'fixture-secret', source: 'fixture' })) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await registries(ctx)
  await ctx.plugin(FixtureCredentials, { resolve })
  const fiber = ctx.plugin(ExternalAgents, { agents: [config] })
  await fiber
  const parent = await parentAgent(ctx)
  const service = ctx.externalAgentSubagents
  const id = service.catalog()[0]!.id
  const start = (prompt = 'Research this question', signal = new AbortController().signal, continuationOf?: SessionId, owner = parent) => service.startActivation(id, {
    label: 'Research task', request: { prompt: [{ type: 'text', text: prompt }], parent: owner }, signal, delivery: 'caller',
  }, continuationOf)
  return { ctx, fiber, parent, service, id, start }
}
