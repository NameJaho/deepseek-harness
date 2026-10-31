/** Conversation publication entry and durable authoring tool cards. */
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { CloudAgentInjected } from './controller.ts'
import { agentMcpSelection } from './agent-mcp.ts'
import css from './page.module.css'

type HeaderProps = PropsRuntime<'conversation.session.header.actions'> & InjectFace<Pick<CloudAgentInjected,
  'hooks' | 'refresh' | 'prepareEditor' | 'openConversation' | 'clone' | 'fromConversation' | 'manage'>> & PropsLocale<'company.cloudAgent'>
type CardProps = ToolCallViewProps & InjectFace<Pick<CloudAgentInjected, 'hooks' | 'preview' | 'manage'>>
  & PropsLocale<'company.cloudAgent'> & PropsRenderSlots<'company.cloudAgent.draft.actions'>

/** Offer publication for ordinary conversations and controlled editing for usage sessions.
 * @param props - current Session hooks and authorized management callbacks.
 * @returns the conversation's Agent identity or publication entry.
 */
export function CloudAgentHeaderAction(props: HeaderProps) {
  const view = props.useCloudAgent(state => state)
  const preset = props.useProjection('agentPreset')
  const selection = view.catalog === null ? undefined : agentMcpSelection(view.catalog, props.sessionId, preset)
  if (selection?.kind === 'release') return <span className={css.connected}><Tag>{selection.release.definition.name} · {props.t('version', { version: String(selection.release.version) })}</Tag>
    <Button variant="ghost" disabled={view.busy} onClick={() => {
      if (selection.record === undefined) { void props.clone(selection.id, selection.release.id); return }
      void props.prepareEditor(selection.id).then((id) => { if (id !== undefined) props.openConversation(id) })
    }}>{props.t(selection.record === undefined ? 'clone' : 'editAgent')}</Button></span>
  if (selection?.kind === 'draft') return <span className={css.connected}><Tag>{selection.record.draft.name} · {props.t('draft')}</Tag>
    <Button variant="ghost" disabled={view.busy} onClick={() => { props.manage(selection.record.id) }}>{props.t('publish')}</Button></span>
  if (selection?.kind === 'new') return <Tag>{props.t('authoringSession')}</Tag>
  return <Button variant="ghost" disabled={view.busy || view.catalog === null || preset === 'minimal'}
    onClick={() => { void props.fromConversation(props.sessionId) }}>{props.t('fromChat')}</Button>
}

/** Present saved draft metadata without exposing executable or connection settings.
 * @param props - durable tool result and shared management actions.
 * @returns requirements and explicit configuration/test actions.
 */
export function CloudAgentDraftCard(props: CardProps) {
  const view = props.useCloudAgent(state => state)
  if (props.phase === 'preparing' || !('kind' in props.block)) return <div className={css.chatCard} role="status">{props.t('authoring')}</div>
  const block = props.block
  if (block.isError) return <div className={css.chatCard} role="alert">{props.t('failed')}<Button variant="ghost" onClick={() => { props.inspect?.() }}>{props.t('details')}</Button></div>
  const meta = block.meta
  const id = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'cloudAgentId' in meta ? meta.cloudAgentId : undefined
  const record = view.catalog?.mine.find(item => item.id === id)
  if (record === undefined) return <div className={css.chatCard}><span>{props.t(id === undefined ? 'catalogReady' : 'saved')}</span>
    <Button variant="ghost" onClick={() => { props.manage() }}>{props.t('manage')}</Button></div>
  return <article className={css.chatCard} data-cloud-agent-draft={record.id}>
    <header className={css.cardHeading}><h2>{record.draft.name}</h2><Tag>{props.t(record.publishedReleaseId === null ? 'draft' : 'published')}</Tag></header>
    <p className={css.description}>{record.draft.description}</p><p className={css.metadata}>{props.t('savedRevision', { revision: String(record.revision) })}</p>
    <div className={css.capabilities}>
      {[...new Set([...(record.draft.mcpTools ?? []), ...(record.draft.skills ?? []), ...(record.draft.knowledgeSources ?? []).map(id =>
        view.catalog?.capabilities.knowledgeSources?.find(source => source.id === id)?.name ?? id)])]
        .map(name => <Tag key={name}>{name}</Tag>)}
    </div>
    <details className={css.requirements}><summary>{props.t('requirements')}</summary><pre>{record.draft.instructions}</pre></details>
    <div className={css.actions}><Button variant="outline" disabled={view.busy} onClick={() => { void props.preview(record, props.sessionId) }}>{props.t('preview')}</Button>
      <Button variant="primary" disabled={view.busy} onClick={() => { props.manage(record.id) }}>{props.t('fullConfig')}</Button>
      {props.renderSlot('company.cloudAgent.draft.actions', { record })}</div>
  </article>
}
