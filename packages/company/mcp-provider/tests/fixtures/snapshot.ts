/** Loopback Market fixture for the shipped headless profile's recorded member-tool turn. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WecomMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'
import HttpProvider, { Config } from '../../src/http.ts'
import { companyMcpToolName } from '../../src/provider.ts'
import type { CompanyMcpId } from '../../src/types.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MemoryCredentials } from '../../../../credentials/credentials/tests/memory.ts'

export const inject = ['tools']
type ToolSetup = { tool: ToolDefinition } | { error: unknown }

/** Mount one member's real HTTP provider and expose its resolved tool to the model.
 * @param ctx - headless profile services.
 */
export async function apply(ctx: Context): Promise<void> {
  const toolReady = Promise.withResolvers<ToolSetup>()
  ctx.on('agent/created', async () => {
    const result = await toolReady.promise
    if ('error' in result) throw result.error
    ctx.effect(() => ctx.tools.register(result.tool))
  })
  try { await initialize(ctx, toolReady.resolve) }
  catch (error) {
    toolReady.resolve({ error })
    throw error
  }
}

async function initialize(ctx: Context, ready: (result: ToolSetup) => void): Promise<void> {
  await ctx.plugin(MemoryCredentials, { DSH_MCP_MARKET_TOKEN: 'SNAPSHOT_MARKET_SERVICE' })
  const subject: WecomMarketSubject = { scope: brandString<WecomMarketSubject['scope']>('wecom:fixture:alice'),
    corpId: brandString<WecomMarketSubject['corpId']>('fixture'), sub: brandString<WecomMarketSubject['sub']>('alice') }
  const serverInfo = { id: 'crm', path: 'crm', name: 'CRM', description: 'Authorized customer lookup',
    authorized: true, published: true, status: 'available' }
  const tool = { name: 'lookup', description: 'Read the current member’s permitted customer summary.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  let authorized = true
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    if (request.headers.authorization !== 'Bearer SNAPSHOT_MARKET_SERVICE' || body.sub !== 'alice' || body.corpId !== 'fixture') {
      throw new Error('Unexpected snapshot Market identity')
    }
    const route = request.url?.split('/').at(-1)
    const data = route === 'page' ? { records: [serverInfo], total: 1, pageNum: 1, pageSize: 100 }
      : route === 'detail' ? { ...serverInfo, tools: [tool] }
        : { isError: false, content: [{ type: 'text', text: 'Member-authorized CRM result.' }] }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(authorized ? { success: true, code: '200', data } : { success: false, code: 'FORBIDDEN' }))
    if (route === 'invoke') authorized = false
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.statusCode = 500
      response.end(error instanceof Error ? error.message : 'Market fixture failed')
    })
  })
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => { server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }) })
  }, 'snapshot Market HTTP server')
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing snapshot Market address')
  ctx.provide('companyWecomAuth', { marketSubject: () => subject, registerResourceProvider: () => async () => {} })
  await ctx.plugin(HttpProvider, Config({ baseUrl: `http://127.0.0.1:${String(address.port)}`, corpId: 'fixture',
    tokenRef: 'DSH_MCP_MARKET_TOKEN' } as Config))
  await ctx.inject(['companyMcpProvider', 'tools'], async (services) => {
    const resolved = await services.companyMcpProvider.resolveTool(subject, companyMcpToolName(brandString<CompanyMcpId>('crm'), 'lookup'))
    if (resolved === undefined) throw new Error('Missing authorized snapshot tool')
    ready({ tool: resolved.tool })
  })
}
