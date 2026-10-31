/** Release-only schema, execution-policy and literal-prompt regressions. */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, projectToolSchema, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { expect, it, vi, type TestContext } from 'vitest'
import * as Runtime from '../src/index.ts'

async function fixture(test: TestContext, mode: 'authoring' | 'release', skills: Runtime.CloudAgentRuntimeSkill[] = [],
  knowledgeSources: string[] = []) {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, { personaPrefix: 'GLOBAL_PERSONA' })
  await ctx.plugin(Tools)
  ctx.tools.setExecutor({ describe: definitions => ({ schemas: definitions.map(definition => projectToolSchema(definition, false)) }),
    execute: async () => { throw new Error('This fixture dispatches through ToolExecutionPipeline') } })
  const external = vi.fn(async () => 'GLOBAL_EXECUTION')
  const tool = (name: string, execute = external) => defineTool({ name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] }, execute })
  for (const name of ['bash', 'mcp__unapproved__ping', 'cloud_agent', 'cloud_report']) ctx.tools.register(tool(name))
  const pinned = vi.fn(async () => 'PINNED_EXECUTION')
  const validate = vi.fn(async () => {})
  const files = vi.fn(() => [])
  const search = vi.fn(async () => ({ sourceId: 'hr', returned: 1, totalHits: 1, belowThreshold: 0, hits: [] }))
  ctx.provide('cloudAgents', {
    releaseMcpTools: async () => [tool('mcp__approved__ping', pinned)], validateCapabilities: validate,
    conversationFiles: files, conversationReport: () => ({ name: 'report.txt', content: 'ok', bytes: 2, mediaType: 'text/plain' }),
    readConversationFile: async () => ({ text: 'uploaded text' }), searchKnowledge: search,
  } as never)
  // The runtime only needs a scoped identity and the two pending inbox queues.
  const agent = { id: brandString<Agent['id']>('runtime-session') } as Agent
  let scope!: ReturnType<typeof createScope>
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) },
    { inject: ['tools', 'systemPrompt'] }))
  Object.assign(agent, { ctx: scope.ctx, inbox: { nextTurn: [], nextStep: [] } })
  const fiber = scope.ctx.plugin(Runtime, Runtime.Config({ mode, releaseId: 'release-1',
    instructions: 'Literal {{not_an_expression}}', mcpTools: ['mcp__approved__ping'], skills, knowledgeSources }))
  await fiber
  await ctx.serial('agent/created', { agent, source: 'startup' })
  const execute = async (name: string, args: object = {}) => {
    const pipeline = new ToolExecutionPipeline(ctx)
    const input: ToolExecutionInput = { name, arguments: args, agent,
      callId: brandString<ToolExecutionInput['callId']>('runtime-call'), signal: new AbortController().signal }
    const prepared = await pipeline.prepare(input)
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
    return pipeline.complete(prepared.exec, outcome)
  }
  return { ctx, agent, scope, fiber, external, pinned, validate, files, search, execute }
}

it('exposes pinned MCP, reports and selected skills, rejects global execution and retains Agent policy through runtime unload', async (test) => {
  const f = await fixture(test, 'release', [{ name: 'sales', description: 'Approved analysis', content: 'PINNED_SKILL',
    resources: [{ path: 'reference.txt', base64: Buffer.from('PINNED_RESOURCE').toString('base64') }] }])
  expect(f.ctx.tools.schemas(f.agent).map(schema => schema.name).sort()).toEqual(['cloud_report', 'cloud_skill', 'mcp__approved__ping'])
  const prompt = renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent }))
  expect(prompt).toContain('Literal {{not_an_expression}}')
  expect(prompt).toContain('- sales: Approved analysis')
  expect(prompt).not.toContain('GLOBAL_PERSONA')
  expect(prompt).not.toContain('PINNED_SKILL')
  expect(prompt).not.toContain('cloud_knowledge')
  expect((await f.execute('mcp__approved__ping')).content).toEqual([{ type: 'text', text: 'PINNED_EXECUTION' }])
  expect((await f.execute('bash')).isError).toBe(true)
  expect((await f.execute('mcp__unapproved__ping')).isError).toBe(true)
  expect(f.external).not.toHaveBeenCalled()
  expect((await f.execute('cloud_skill', { name: 'sales' })).content).toEqual([expect.objectContaining({ text: expect.stringContaining('PINNED_SKILL') as string })])
  expect((await f.execute('cloud_skill', { name: 'sales', resource: 'reference.txt' })).content).toEqual([expect.objectContaining({ text: expect.stringContaining('PINNED_RESOURCE') as string })])
  expect((await f.execute('cloud_skill', { name: 'unselected' })).isError).toBe(true)
  expect((await f.execute('cloud_file', { action: 'list' })).isError).toBe(true)
  await f.fiber.dispose()
  expect((await f.execute('bash')).isError).toBe(true)
  await f.scope.dispose()
  expect(f.ctx.tools.schemas(f.agent).map(schema => schema.name)).toContain('bash')
})

it('registers cloud_file only after this Agent receives a file and propagates pre-step signature validation failures', async (test) => {
  const f = await fixture(test, 'release')
  expect(f.ctx.tools.schemas(f.agent).map(schema => schema.name)).not.toContain('cloud_file')
  await f.ctx.serial('agent/inbox/inserted', { agent: f.agent,
    message: { content: [{ type: 'file' }] } } as never)
  expect(f.ctx.tools.schemas(f.agent).map(schema => schema.name)).toContain('cloud_file')
  expect((await f.execute('cloud_file', { action: 'list' })).content).toEqual([{ type: 'text', text: '[]' }])
  f.validate.mockRejectedValueOnce(new Error('Schema changed'))
  await expect(agentEvents(f.ctx, f.agent).waterfall('agent/pre-step', { modelSelection: { provider: 'selected', model: 'model' },
    messages: [], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages: [] })))
    .rejects.toThrow('Schema changed')
})

it('restricts retained authoring to cloud_agent and never resolves release execution tools', async (test) => {
  const f = await fixture(test, 'authoring')
  expect(f.ctx.tools.schemas(f.agent).map(schema => schema.name)).toEqual(['cloud_agent'])
  expect((await f.execute('cloud_agent')).isError).not.toBe(true)
  expect((await f.execute('bash')).isError).toBe(true)
  expect((await f.execute('cloud_report')).isError).toBe(true)
  expect(f.pinned).not.toHaveBeenCalled()
  expect(renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent }))).toContain('Literal {{not_an_expression}}')
})

it('exposes cloud_knowledge for approved sources and forwards only the source id and question', async (test) => {
  const f = await fixture(test, 'release', [], ['hr', 'operations'])
  expect(f.ctx.tools.schemas(f.agent).map(schema => schema.name).sort()).toEqual(['cloud_knowledge', 'cloud_report', 'mcp__approved__ping'])
  const schema = f.ctx.tools.schemas(f.agent).find(item => item.name === 'cloud_knowledge')
  expect(JSON.stringify(schema)).toContain('"enum":["hr","operations"]')
  expect(renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent }))).toContain('Approved knowledge sources: hr, operations.')
  const result = await f.execute('cloud_knowledge', { sourceId: 'hr', query: 'Leave policy' })
  expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('"sourceId":"hr"') as string }])
  expect(f.search).toHaveBeenCalledWith(f.agent, 'release-1', 'hr', 'Leave policy', expect.any(AbortSignal), {
    messages: [{ role: 'user', content: 'Leave policy' }],
  })
  expect((await f.execute('cloud_knowledge', { sourceId: 'finance', query: 'Budget' })).isError).toBe(true)
  expect(f.search).toHaveBeenCalledOnce()
})

it('never exposes knowledge search to retained authoring', async (test) => {
  const f = await fixture(test, 'authoring', [], ['hr'])
  expect(f.ctx.tools.schemas(f.agent).map(schema => schema.name)).toEqual(['cloud_agent'])
  expect(renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent }))).not.toContain('cloud_knowledge')
})

it('pins the keyless knowledge tool and prompt surface', async (test) => {
  const f = await fixture(test, 'release', [], ['hr', 'operations'])
  expect({
    prompt: renderPrompt(await f.ctx.systemPrompt.assemble({ scope: f.agent })),
    tools: f.ctx.tools.schemas(f.agent).filter(schema => schema.name === 'cloud_knowledge'),
  }).toMatchSnapshot()
})
