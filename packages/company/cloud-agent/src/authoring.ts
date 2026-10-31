/** Model-facing reusable requirements extraction; publication is an explicit human command. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CompanyMcpId } from '@deepseek-ai/dsh-company-mcp-provider/types'
import type { CloudAgentService } from './index.ts'
import type { CloudAgentDraft, CloudAgentId, CloudAgentReleaseId } from './types.ts'

/** Register draft authoring with no shell, project, credentials or code-plugin inputs.
 * @param ctx - tool and single MCP provider registration owner.
 * @param service - authorized durable draft and release owner.
 */
export function registerAuthoringTool(ctx: Context, service: CloudAgentService): void {
  ctx.tools.register(defineTool({
    name: 'cloud_agent',
    description: 'Save reusable Agent requirements from the confirmed conversation. Read catalog first. '
      + 'Preserve confirmed rules and omit credentials, endpoints, temporary paths and one-off results. '
      + 'Use discover for a selected MCP server; select exact catalog or discovered tool and skill names. '
      + 'Knowledge uses a separate direct retrieval service: select knowledgeSources from catalog even when no MCP servers exist. '
      + 'Saving does not publish. Show the saved name, description and revision; the user publishes with '
      + '/publish-agent confirm <revision> <public|private>. Preview opens a separate private test conversation.',
    parameters: {
      action: { type: 'string', required: true, enum: ['catalog', 'discover', 'save', 'preview', 'clone'] },
      agentId: { type: 'string', description: 'Exact draft or published Agent id; omission uses this conversation’s draft.' },
      expectedRevision: { type: 'number', description: 'Exact saved revision required for replacing or testing a draft.' },
      releaseId: { type: 'string', description: 'Exact accessible published release id, required for clone.' },
      serverId: { type: 'string', description: 'Exact MCP server id from catalog, required for discover.' },
      name: { type: 'string', description: 'For save: reusable display name, at most 80 characters.' },
      description: { type: 'string', description: 'For save: purpose, at most 500 characters; omission retains the current description.' },
      instructions: { type: 'string', description: 'For save: complete confirmed instructions, at most 32768 characters.' },
      provider: { type: 'string', description: 'Configured provider; omission retains the draft or current Session selection.' },
      model: { type: 'string', description: 'Configured model; omission retains the draft or current Session selection.' },
      mcpTools: { type: 'array', items: { type: 'string' }, description: 'Exact MCP tools; omission retains current choices, [] removes them.' },
      mcpServers: { type: 'array', items: { type: 'string' }, description: 'Selected server ids; their current tools are pinned when saving the draft. Omission retains choices.' },
      skills: { type: 'array', items: { type: 'string' }, description: 'Installed skill names to snapshot; omission retains choices, [] removes them.' },
      knowledgeSources: { type: 'array', items: { type: 'string' }, description: 'Direct retrieval source ids from capabilities.knowledgeSources, independent of MCP; omission retains choices, [] removes them.' },
    },
    output: {
      schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => {
        const parsed: unknown = JSON.parse(value)
        if (typeof parsed !== 'object' || parsed === null || !('id' in parsed) || typeof parsed.id !== 'string') return null
        return { cloudAgentId: parsed.id, ...'releaseId' in parsed && typeof parsed.releaseId === 'string'
          ? { cloudAgentReleaseId: parsed.releaseId } : {} }
      },
    },
    async execute(args, execution) {
      const agent = execution.agent
      if (agent === undefined) throw new Error('Cloud Agent authoring requires a live conversation')
      execution.signal.throwIfAborted()
      const catalog = await service.catalog()
      const boundId = catalog.conversations.find(item => item.sessionId === agent.id)?.agentId
      const current = catalog.mine.find(record => record.id === (args.agentId ?? boundId))
      if (args.action === 'catalog') return JSON.stringify({
        agents: catalog.mine.map(record => ({ id: record.id, name: record.draft.name, revision: record.revision })),
        currentDraft: current === undefined ? null : { id: current.id, revision: current.revision, ...current.draft },
        published: catalog.published.map(entry => ({ id: entry.id, releaseId: entry.release.id, name: entry.release.definition.name })),
        models: catalog.models, capabilities: catalog.capabilities,
      })
      if (args.action === 'discover') {
        if (args.serverId === undefined) throw new Error('discover requires serverId from catalog')
        const mcp = ctx.get('companyMcpProvider')
        if (mcp === undefined) throw new Error('No MCP provider is configured; direct knowledge sources are independent of MCP')
        const subject = ctx.companyWecomAuth.marketSubject(agent.id)
        return JSON.stringify(await mcp.discover(subject, brandString<CompanyMcpId>(args.serverId), execution.signal))
      }
      if (args.action === 'save') {
        if (args.name === undefined || args.instructions === undefined) throw new Error('save requires name and complete instructions')
        const selection = agent.model.current()
        const base = current?.draft
        const draft: CloudAgentDraft = { name: args.name, description: args.description ?? base?.description ?? '', instructions: args.instructions,
          provider: args.provider ?? base?.provider ?? selection?.provider ?? catalog.models.default.provider,
          model: args.model ?? base?.model ?? selection?.model ?? catalog.models.default.model,
          mcpTools: args.mcpTools ?? base?.mcpTools ?? [],
          mcpServers: args.mcpServers?.map(id => brandString<CompanyMcpId>(id)) ?? base?.mcpServers ?? [],
          skills: args.skills ?? base?.skills ?? [], knowledgeSources: args.knowledgeSources ?? base?.knowledgeSources ?? [] }
        const subject = ctx.companyWecomAuth.marketSubject(agent.id)
        const mcp = ctx.get('companyMcpProvider')
        if (mcp === undefined && ((draft.mcpServers?.length ?? 0) > 0 || (draft.mcpTools?.length ?? 0) > 0)) {
          throw new Error('No MCP provider is configured; select direct knowledge sources instead')
        }
        if (mcp !== undefined) for (const name of draft.mcpTools ?? []) if (await mcp.resolveTool(subject, name) === undefined) {
          throw new Error('Select an available MCP tool from catalog or discovery')
        }
        if (draft.skills?.some(name => !catalog.capabilities.skills.some(skill => skill.name === name))) throw new Error('Select installed skills from catalog')
        if (mcp !== undefined) for (const id of draft.mcpServers ?? []) await mcp.discoverTools(subject, id)
        const saved = await service.saveFromConversation(agent, String(execution.callId), draft,
          args.agentId === undefined ? undefined : brandString<CloudAgentId>(args.agentId), args.expectedRevision)
        return JSON.stringify({ action: 'saved', id: saved.id, revision: saved.revision, draft: saved.draft,
          confirmation: `/publish-agent confirm ${saved.revision} <public|private>` })
      }
      const targetId = args.agentId ?? current?.id
      if (targetId === undefined) throw new Error('Supply agentId from catalog')
      const id = brandString<CloudAgentId>(targetId)
      if (args.action === 'clone') {
        if (args.releaseId === undefined) throw new Error('clone requires releaseId from catalog')
        const saved = await service.clone({ id, releaseId: brandString<CloudAgentReleaseId>(args.releaseId), authoringSessionId: agent.id })
        return JSON.stringify({ action: 'cloned', id: saved.id, revision: saved.revision, draft: saved.draft })
      }
      if (args.expectedRevision === undefined) throw new Error('preview requires expectedRevision from the saved draft')
      return JSON.stringify({ action: 'preview', id, ...await service.preview({ id,
        expectedRevision: args.expectedRevision, authoringSessionId: agent.id }, execution.signal) })
    },
    presentCall: args => ({ card: 'generic', title: 'Cloud Agent', kind: args.action === 'catalog' || args.action === 'discover' ? 'read' : 'other', rawInput: args }),
  }))
}
