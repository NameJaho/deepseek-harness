/** Human-confirmed Agent creation and publication in ordinary selectable Workspace conversations. */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { SessionPromptRequest } from '@deepseek-ai/dsh-api-session-controller'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { CloudAgentService } from './index.ts'
import { explicitPublicationVisibility } from './publication.ts'

/** Whether an ordinary mode supports conversational Agent authoring.
 * @param ctx - preset declaration owner.
 * @param preset - exact composed preset; omission uses the declared default.
 * @returns true for an ordinary selectable mode, never a retained release.
 */
export function isConversationalAuthoringPreset(ctx: Context, preset: string | undefined): boolean {
  return ctx.agentPresets.availabilityOf(preset ?? ctx.agentPresets.defaultId) === 'selectable'
}

/** Register explicit publication confirmation without a model-mediated publish operation.
 * @param ctx - Session lifecycle and optional command registry owner.
 * @param service - current owner-scoped draft and publication service.
 */
export function registerAuthoringCommands(ctx: Context, service: CloudAgentService): void {
  ctx.inject(['commands'], (commandCtx) => {
    const entries = new Map<Agent, { scope: Scope; stops: (() => void)[] }>()
    const remove = async (agent: Agent): Promise<void> => {
      const entry = entries.get(agent)
      entries.delete(agent)
      await entry?.scope.dispose()
    }
    const sync = (agent: Agent): void => {
      let entry = entries.get(agent)
      if (entry === undefined) { entry = { scope: createScope(commandCtx, agent), stops: [] }; entries.set(agent, entry) }
      for (const stop of entry.stops.splice(0)) stop()
      const preset = ctx.agentPresets.composedPreset(agent.ctx)
      if (preset !== 'cloud-agent-authoring' && !isConversationalAuthoringPreset(ctx, preset)) return
      const scoped = entry.scope.ctx
      const writable = (): boolean => {
        const permission = ctx.permissionPresets.current(agent.session)
        return permission === 'workspace-write' || permission === 'danger-full-access'
      }
      const queueDraft = async (requirements: string, signal: AbortSignal, publish = false): Promise<void> => {
        await ctx.sessionController.prompt({ sessionId: agent.id,
          requestId: brandString<SessionPromptRequest['requestId']>(randomUUID()), mode: 'queue', content: [{ type: 'text', text:
            'Create or update an Agent draft from the confirmed reusable requirements and current configuration in this conversation. '
            + 'Read cloud_agent catalog, then save a complete draft using only approved MCP tools, knowledge sources and skills. '
            + (publish ? 'Then call cloud_agent publish. Publish privately by default; use public only when I explicitly request the public space. '
              : 'Do not publish. Show the saved name and description; I can request publication in natural language. ')
            + 'Do not ask me to type a revision or confirmation command.'
            + (requirements === '' ? '' : `\n\nAdditional requirements:\n${requirements}`) }] }, signal)
      }
      entry.stops.push(scoped.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-company-cloud-agent/create-agent'),
        name: '创建智能体', aliases: ['create-agent'], description: '从当前对话保存可复用智能体需求', input: { hint: '[需求]' },
        handler: ({ rawInput, signal }) => ctx.agents.withInitiator(agent, async () => {
          signal.throwIfAborted()
          if (ctx.agents.get(agent.id) !== agent) return { kind: 'error', text: 'This conversation is no longer active.' }
          if (!writable()) return { kind: 'error', text: 'Select workspace-write before saving an Agent. Your conversation is preserved.' }
          await queueDraft(rawInput.trim(), signal)
          return { kind: 'success', text: 'Draft request queued. Review its name, description and revision before publishing.' }
        }),
      }))
      entry.stops.push(scoped.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-company-cloud-agent/publish-agent'),
        name: '发布智能体', aliases: ['publish-agent'], description: '确认发布当前对话中的智能体并选择可见范围', input: { hint: '[可见范围]' },
        handler: ({ rawInput, signal }) => ctx.agents.withInitiator(agent, async () => {
          signal.throwIfAborted()
          if (ctx.agents.get(agent.id) !== agent) return { kind: 'error', text: 'This conversation is no longer active.' }
          if (!writable()) return { kind: 'error', text: 'Select workspace-write before publishing. Your draft is preserved.' }
          const catalog = await service.catalog()
          const binding = catalog.conversations.find(item => item.sessionId === agent.id && item.role === 'authoring')
          const record = catalog.mine.find(item => item.id === binding?.agentId)
          if (record === undefined) {
            await queueDraft(rawInput.trim(), signal, true)
            return { kind: 'success', text: '正在整理智能体，保存后默认发布为私有；如需公共空间，请继续明确说明。' }
          }
          const result = await service.requestPublication(agent, record.id, record.revision, signal, 'zh', explicitPublicationVisibility(rawInput))
          return { kind: 'success', text: result.action === 'cancelled' ? '已保留草稿，暂不发布。'
            : result.action === 'already-published' ? `${record.draft.name} 已发布，无需重复发布。`
              : `${record.draft.name} 已发布${result.visibility === 'public' ? '到公共空间' : '为私有智能体'}。${result.nextAction ?? ''}` }
        }),
      }))
    }
    commandCtx.on('agent/created', ({ agent }) => { sync(agent) })
    commandCtx.on('agent/disposed', ({ agent }) => {
      void remove(agent).catch((error: unknown) => { commandCtx.logger.warn(`Cloud Agent command cleanup failed: ${String(error)}`) })
    })
    commandCtx.on('agent-preset/selected', (id) => { const agent = ctx.agents.get(id); if (agent !== undefined) sync(agent) })
    commandCtx.effect(() => async () => { await Promise.all([...entries.keys()].map(remove)) }, 'cloud-agent: conversational commands')
    for (const agent of ctx.agents.list()) sync(agent)
  })
}
