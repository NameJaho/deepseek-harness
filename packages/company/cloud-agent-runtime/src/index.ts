/** Literal Cloud Agent prompts and release-scoped tool policies. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PERSONA_PREFIX_SECTION } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-company-cloud-agent'

/** Scoped runtime plugin name. */
export const name = 'company-cloud-agent-runtime'
/** The catalog owns executable release authorization. */
export const inject = ['tools', 'systemPrompt', 'cloudAgents']

/** Trusted configuration compiled from a saved release by the catalog. */
export interface Config {
  /** Literal system instructions, without template expansion or executable YAML. */
  instructions: string
  /** Immutable release the tool must match at execution. */
  releaseId: string
  /** Exact deployment MCP tool names selected by the release. */
  mcpTools?: string[]
  /** Published skill instructions and resources. */
  skills?: CloudAgentRuntimeSkill[]
  /** Authoring or ordinary retained release behavior. */
  mode?: 'authoring' | 'release'
}

/** One regular resource captured into a published Skill snapshot. */
export interface CloudAgentRuntimeSkillResource {
  /** Relative resource path under the Skill directory. */
  path: string
  /** Base64 bytes retained by the immutable release. */
  base64: string
}

/** Pinned Skill instructions and resources available to one release Session. */
export interface CloudAgentRuntimeSkill {
  /** Kebab-case Skill name. */
  name: string
  /** Short catalog description. */
  description: string
  /** Immutable instruction body. */
  content: string
  /** Regular non-link resources included in the release. */
  resources: CloudAgentRuntimeSkillResource[]
}

/** Runtime configuration never accepts an endpoint, credential, environment or host command. */
export const Config: z<Config> = z.object({
  instructions: z.string().min(1).required(),
  releaseId: z.string().min(1).required(),
  mcpTools: z.array(z.string()).default([]),
  skills: z.array(z.object({
    name: z.string().required(), description: z.string().required(), content: z.string().required(),
    resources: z.array(z.object({ path: z.string().required(), base64: z.string().required() })).required(),
  })).default([]),
  mode: z.union(['authoring', 'release']).default('release'),
})

/**
 * Register a literal preset prompt and capabilities with Agent-owned tool policies.
 * @param ctx - scoped registries and the Host execution service.
 * @param config - immutable release instructions and capability selection.
 */
export function apply(ctx: Context, config: Config): void {
  const authoring = config.mode === 'authoring'
  const skills = config.skills ?? []
  const denial = authoring ? 'This conversation creates and edits agent drafts.'
    : 'Only tools explicitly enabled for this Cloud Agent can be used.'
  // Tool policies survive runtime unloading until their owning Agent is disposed.
  ctx.on('agent/created', async ({ agent }) => {
    const allowed = new Set(authoring ? ['cloud_agent'] : [
      ...config.mcpTools ?? [], ...skills.length > 0 ? ['cloud_skill'] : [], 'cloud_report',
    ])
    const mask = createScope(agent.ctx, agent)
    agent.ctx.effect(() => mask.rawDispose, 'cloud-agent: Agent tool policy')
    if (!authoring) {
      for (const tool of await ctx.cloudAgents.releaseMcpTools(config.releaseId, agent.id)) mask.ctx.tools.register(tool)
    }
    // All release tools are scope-owned; the global mask may name only inherited tools.
    mask.ctx.tools.restrict({ allow: authoring ? ['cloud_agent'] : [] })
    mask.ctx.tools.guard((execution) => {
      if (allowed.has(execution.name)) return
      return denial
    })
    if (!authoring) {
      allowed.add('cloud_report')
      mask.ctx.tools.register(defineTool({ name: 'cloud_report',
        description: 'Create a downloadable UTF-8 report from complete text. Use .md, .csv, .json or .txt, with no directory. For an evaluation, include each case, expected answer, actual answer, evidence, pass/fail and totals. The result is saved in this conversation and shown as a download card; no shell permission is needed. Do not claim a file exists before this tool succeeds.',
        parameters: {
          name: { type: 'string', required: true, description: 'Plain filename ending in .md, .csv, .json or .txt.' },
          content: { type: 'string', required: true, description: 'Complete report text, within the deployment byte limit.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => {
          const report = JSON.parse(value) as { name: string; bytes: number }
          return [{ type: 'text', text: `Downloadable report: ${report.name} (${report.bytes} bytes)` }]
        }, presentationMeta: (_args, value) => ({ companyReport: JSON.parse(value) as {
          name: string
          content: string
          mediaType: string
          bytes: number
        } }) },
        execute(args, execution) {
          if (execution.agent !== agent) throw new Error('Report tool belongs to another conversation')
          execution.signal.throwIfAborted()
          return Promise.resolve(JSON.stringify(ctx.cloudAgents.conversationReport(agent, args.name, args.content)))
        },
      }))
      let filesRegistered = false
      const registerFiles = (): void => {
        if (filesRegistered) return
        filesRegistered = true
        allowed.add('cloud_file')
        mask.ctx.tools.register(defineTool({ name: 'cloud_file',
          description: 'List files uploaded to this conversation or read a verified UTF-8 text page. Use the returned attachmentId for reads and nextOffset for the next page. Files remain available after compaction. This tool grants no shell access or arbitrary filesystem paths.',
          parameters: {
            action: { type: 'string', required: true, enum: ['list', 'read'] },
            attachmentId: { type: 'string', description: 'Exact attachmentId returned by list, required for read.' },
            offset: { type: 'number', description: 'Zero-based Unicode character offset; omit for the first page.' },
            limit: { type: 'number', description: 'Maximum characters in this page, bounded by the deployment.' },
          },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute(args, execution) {
            if (execution.agent !== agent) throw new Error('Attachment tool belongs to another conversation')
            if (args.action === 'list') return JSON.stringify(ctx.cloudAgents.conversationFiles(agent))
            if (args.attachmentId === undefined) throw new Error('read requires attachmentId from list')
            return JSON.stringify(await ctx.cloudAgents.readConversationFile(agent, {
              attachmentId: brandString<AttachmentIdType>(args.attachmentId),
              ...args.offset === undefined ? {} : { offset: args.offset }, ...args.limit === undefined ? {} : { limit: args.limit },
            }, execution.signal))
          },
        }))
      }
      if (ctx.cloudAgents.conversationFiles(agent).length > 0
        || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => message.content.some(block => block.type === 'file'))) {
        registerFiles()
      }
      mask.ctx.on('agent/inbox/inserted', ({ message }) => {
        if (message.content.some(block => block.type === 'file')) registerFiles()
      })
    }
  })
  if (authoring) {
    ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: [config.instructions, ...skills.map(skill => `# Skill: ${skill.name}\n\n${skill.content}`)].join('\n\n'),
      interpolate: false, complete: true })
    ctx.systemPrompt.suppressRuntimeContext()
    return
  }
  ctx.on('agent/pre-step', async (request, next) => {
    await ctx.cloudAgents.validateCapabilities(config.releaseId, request.agent.id)
    return next()
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: PERSONA_PREFIX_SECTION,
    order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
    text: [config.instructions,
      ...skills.length === 0 ? [] : [`Available skills (load instructions with cloud_skill before using them):\n${skills.map(skill => `- ${skill.name}: ${skill.description}`).join('\n')}`],
    ].join('\n\n'),
    interpolate: false,
    complete: true,
  }), 'cloud-agent: literal instructions')
  ctx.systemPrompt.suppressRuntimeContext()
  if (skills.length > 0) ctx.tools.register(defineTool({
    name: 'cloud_skill',
    description: 'Load a selected skill\'s published instructions or one of its pinned resources. '
      + 'Follow the skill using only the tools available to this agent.',
    parameters: {
      name: { type: 'string', required: true, description: 'Exact name from the available skill list.' },
      resource: { type: 'string', description: 'Optional exact resource path returned by loading the skill.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute(args) {
      const skill = skills.find(item => item.name === args.name)
      if (skill === undefined) throw new Error('This skill is not selected for the agent')
      if (args.resource === undefined) return Promise.resolve(JSON.stringify({ name: skill.name, instructions: skill.content,
        directory: `.skills/${skill.name}`, resources: skill.resources.map(resource => resource.path) }))
      const resource = skill.resources.find(item => item.path === args.resource)
      if (resource === undefined) throw new Error('This resource is not included in the published skill')
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(resource.base64, 'base64'))
        return Promise.resolve(JSON.stringify({ name: skill.name, path: resource.path, encoding: 'utf8', data: text }))
      } catch (_binaryResource: unknown) {
        return Promise.resolve(JSON.stringify({ name: skill.name, path: resource.path, encoding: 'base64', data: resource.base64 }))
      }
    },
  }))
}
