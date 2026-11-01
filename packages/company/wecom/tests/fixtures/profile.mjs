/** Scripted external LLM; real Web Loader, tools, authoring, publication and durable Session. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'

const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const draft = { name: 'WeCom regression agent', description: 'Regression fixture', instructions: 'PINNED_WECOM_RULES',
  provider: 'wecom-fixture', model: 'fixture-model', codeExecution: false, mcpTools: [], skills: [] }

class Model extends LlmAdapter {
  nextCall = 0
  listModels(provider) { return Promise.resolve([{ provider, id: 'fixture-model', name: 'Fixture model' }]) }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model, contextWindow: 128000, defaultMaxTokens: 4096 }) }
  async *stream(options) {
    const index = options.messages.findLastIndex(message => message.role === 'user'
      && (message.source.kind === 'user' || message.source.kind === 'user-rpc'))
    const task = index < 0 ? '' : textOf(options.messages[index])
    const results = options.messages.slice(index + 1).filter(message => message.role === 'tool')
    let call
    let answer
    if (task === 'Create a reusable agent and authorize its WeCom robot.') {
      if (results.length === 0) call = { name: 'cloud_agent', args: { action: 'save', ...draft } }
      else if (results.length === 1) call = { name: 'wecom_publish', args: { action: 'catalog' } }
      else if (results.length === 2) {
        const catalog = JSON.parse(textOf(results[1]))
        assert.equal(catalog.agents.length, 1)
        call = { name: 'wecom_publish', args: { action: 'authorize', agentId: catalog.agents[0].id } }
      } else answer = 'Authorization is awaiting your scan; the robot is not deployed yet.'
    } else if (task === 'Check the robot connection status.') {
      if (results.length === 0) call = { name: 'wecom_publish', args: { action: 'status' } }
      else answer = 'No robot is connected; finish the official authorization card.'
    } else answer = 'WeCom regression agent'
    if (call !== undefined) {
      assert.ok(options.tools?.some(tool => tool.name === call.name), `Tool not discoverable: ${call.name}`)
      const id = ToolCallId(`wecom-fixture-${++this.nextCall}`)
      const args = JSON.stringify(call.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: call.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: answer }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

export const name = 'wecom-profile-fixture'
export const inject = ['llm', 'cloudAgents', 'companyWecom', 'agents', 'tools', 'appReady', 'appExit']

export function apply(ctx, config) {
  ctx.llm.registerAdapter(['wecom-fixture'], new Model())
  let pending = Promise.resolve()
  const run = async () => {
    const created = await ctx.cloudAgents.startAuthoring({}, new AbortController().signal)
    const author = ctx.agents.get(created.sessionId)
    assert.ok(author)
    for (const task of ['Create a reusable agent and authorize its WeCom robot.', 'Check the robot connection status.']) {
      author.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: task }] }))
      await author.whenIdle()
    }
    const events = author.session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    assert.equal(results.length, 4)
    assert.ok(results.every(event => event.data.message.isError !== true), JSON.stringify(results))
    assert.deepEqual(events.filter(event => event.type === 'turn/end').map(event => event.data.reason),
      [{ kind: 'completed' }, { kind: 'completed' }])
    const record = (await ctx.cloudAgents.catalog()).mine[0]
    const snapshot = await ctx.companyWecom.snapshot()
    assert.equal(snapshot.requests.length, 1)
    assert.equal(snapshot.bindings.length, 0)
    assert.equal(record.releases.length, 1)
    assert.equal(snapshot.requests[0].releaseId, record.publishedReleaseId)
    assert.equal(snapshot.requests[0].agentId, record.id)
    const request = snapshot.requests[0]
    assert.ok(request.expiresAt > Date.now())
    assert.equal(results[2].data.meta.wecomRequestId, request.id)
    assert.equal(results[0].data.meta.cloudAgentId, record.id)
    // Replace only asserted generated identities and authorization time; preserve every other output field.
    const identities = new Map([[record.id, '<agent>'], [request.id, '<request>'],
      [record.publishedReleaseId, '<release>'], [author.id, '<author-session>']])
    const project = (value, key = '') => {
      if (typeof value === 'string' && identities.has(value)) return identities.get(value)
      if (key === 'expiresAt') { assert.equal(value, request.expiresAt); return '<expiry>' }
      if (key === 'createdAt' || key === 'updatedAt') { assert.ok(Number.isInteger(value)); return '<time>' }
      if (Array.isArray(value)) return value.map(item => project(item))
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, project(item, name)]))
      return value
    }
    const transcript = events.flatMap(event => {
      if (event.type === 'user/message') return [{ type: event.type, text: textOf(event.data).replaceAll(author.session.header.cwd, '<workspace>') }]
      if (event.type === 'tool/call') return [{ type: event.type, name: event.data.name, args: project(JSON.parse(event.data.arguments)) }]
      if (event.type === 'tool/result') return [{ type: event.type, value: project(JSON.parse(textOf(event.data.message))), meta: project(event.data.meta) }]
      if (event.type === 'assistant/message') {
        const text = textOf(event.data.message)
        return text === '' ? [] : [{ type: event.type, text }]
      }
      return []
    })
    const json = JSON.stringify(transcript, null, 2) + '\n'
    assert.ok(!json.includes('PINNED_SECRET'))
    await author.session.flush?.()
    await writeFile(config.transcriptPath, json)
    console.log('WECOM_PROFILE_OK')
  }
  ctx.effect(() => {
    const stop = ctx.appReady.onReady(() => {
      pending = run().then(() => { ctx.appExit(0) }, error => { console.error(error); ctx.appExit(1) })
    })
    return async () => { stop(); await pending }
  })
}
