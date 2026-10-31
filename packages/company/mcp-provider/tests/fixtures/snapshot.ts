/** Loopback existing-API fixture for the shipped headless profile's member directory reads. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { WecomMarketSubject } from '@deepseek-ai/dsh-company-wecom-auth/types'
import HttpProvider, { Config } from '../../src/http.ts'

export const inject = ['tools']

/** Mount the real directory provider with only external Market HTTP responses supplied by the fixture.
 * @param ctx - shipped headless profile services.
 */
export async function apply(ctx: Context): Promise<void> {
  const subject: WecomMarketSubject = { scope: brandString<WecomMarketSubject['scope']>('wecom:fixture:alice'),
    corpId: brandString<WecomMarketSubject['corpId']>('fixture'), sub: brandString<WecomMarketSubject['sub']>('alice') }
  let authorized = true
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    let data: unknown
    switch (request.url) {
      case '/api/mcp/admin/user/list':
        if (body.keyword !== 'alice') throw new Error('Expected current WeCom identity')
        data = { records: [{ userId: 101, thirdUid: 'alice', userStatus: '3', name: 'Alice' }], total: 1, pageNum: 1, pageSize: 100 }
        break
      case '/api/mcp/list': {
        const viewer = JSON.parse(decodeURIComponent(String(request.headers['x-user-info']))) as { userId: number }
        if (viewer.userId !== 101) throw new Error('Expected mapped portal identity')
        data = { records: [{ id: 10001, name: 'crm', displayName: 'CRM', description: 'Customer lookup',
          authorized: true, accessStatus: 'open', toolCount: 1 }], total: 1, pageNum: 1, pageSize: 100 }
        break
      }
      case '/api/internal/mcp/permission/check':
        if (body.sub !== 'alice' || body.path !== 'crm') throw new Error('Expected current member permission query')
        data = { allowed: authorized, reason: authorized ? 'authorized' : 'not_authorized', sub: 'alice', path: 'crm', userId: 101, mcpServiceId: 10001 }
        break
      default: throw new Error('Unexpected Market operation')
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ success: true, code: '200', data }))
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { response.statusCode = 500; response.end('Market fixture failed') })
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
  await ctx.plugin(HttpProvider, Config({ baseUrl: `http://127.0.0.1:${String(address.port)}`, corpId: 'fixture' } as Config))
  await ctx.inject(['companyMcpProvider', 'tools'], (services) => {
    services.tools.register(defineTool({ name: 'member_mcp_catalog', description: 'Read the current member’s permitted MCP directory.',
      parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() {
        const catalog = await services.companyMcpProvider.catalog(subject)
        if (!catalog.loaded) throw new Error('Member directory is unavailable')
        authorized = false
        return JSON.stringify(catalog.servers.map(({ id, name, toolCount }) => ({ id, name, toolCount })))
      },
    }))
  })
}
