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
      const queueDraft = async (requirements: string, signal: AbortSignal): Promise<void> => {
        await ctx.sessionController.prompt({ sessionId: agent.id,
          requestId: brandString<SessionPromptRequest['requestId']>(randomUUID()), mode: 'queue', content: [{ type: 'text', text:
            'Create or update an Agent draft from the confirmed reusable requirements and current configuration in this conversation. '
            + 'Read cloud_agent catalog, then save a complete draft using only approved MCP tools and skills. '
            + 'Do not publish. Show the saved name, description, revision and /publish-agent confirm <revision> <public|private> for me to confirm.'
            + (requirements === '' ? '' : `\n\nAdditional requirements:\n${requirements}`) }] }, signal)
      }
      entry.stops.push(scoped.commands.register({
        definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-company-cloud-agent/create-agent'),
        name: 'create-agent', description: 'Save reusable Agent requirements from this conversation', input: { hint: '[requirements]' },
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
        name: 'publish-agent', description: 'Review and confirm publication of this conversation’s Agent', input: { hint: '[confirm <revision> <public|private>]' },
        handler: ({ rawInput, signal }) => ctx.agents.withInitiator(agent, async () => {
          signal.throwIfAborted()
          if (ctx.agents.get(agent.id) !== agent) return { kind: 'error', text: 'This conversation is no longer active.' }
          if (!writable()) return { kind: 'error', text: 'Select workspace-write before publishing. Your draft is preserved.' }
          const input = rawInput.trim()
          const confirm = /^confirm ([1-9][0-9]*) (public|private)$/u.exec(input)
          if (input !== '' && confirm === null) return { kind: 'error', text: 'Use /publish-agent or /publish-agent confirm <revision> <public|private>.' }
          const catalog = await service.catalog()
          const binding = catalog.conversations.find(item => item.sessionId === agent.id && item.role === 'authoring')
          const record = catalog.mine.find(item => item.id === binding?.agentId)
          if (record === undefined) {
            if (confirm !== null) return { kind: 'error', text: 'No saved draft matches this confirmation. Use /publish-agent to prepare one.' }
            await queueDraft('', signal)
            return { kind: 'success', text: 'Draft request queued. Confirm its saved name, description, revision and visibility before publication.' }
          }
          if (confirm === null) return { kind: 'success', text:
            `${record.draft.name}\n${record.draft.description}\nRevision ${record.revision}\n/publish-agent confirm ${record.revision} <public|private>` }
          const expectedRevision = Number(confirm[1])
          if (!Number.isSafeInteger(expectedRevision)) return { kind: 'error', text: 'Invalid revision. Review the saved draft with /publish-agent.' }
          signal.throwIfAborted()
          const visibility = confirm[2] === 'private' ? 'private' : 'public'
          const saved = await service.publish({ id: record.id, expectedRevision, visibility, authoringSessionId: agent.id })
          const release = saved.releases.find(item => item.id === saved.publishedReleaseId)
          return { kind: 'success', text: `${saved.draft.name} published (${visibility}), version ${release?.version}, release ${saved.publishedReleaseId}.` }
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
