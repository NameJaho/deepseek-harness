/** Information for the exact release and runtime recorded by the displayed Session. */
import { Button, IconInfoOutlineRegular, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CloudAgentInjected } from './controller.ts'
import type { CloudAgentUsageStatus } from '../types.ts'
import type { CloudAgentLocaleKey } from './locales.ts'
import { connectedAgent } from './agent-mcp.ts'
import css from './page.module.css'

type Shared = InjectFace<Pick<CloudAgentInjected, 'hooks' | 'refresh' | 'openConversation'>> & PropsLocale<'company.cloudAgent'>
type NavigationProps = PropsRuntime<'conversation.input.right'> & InjectFace<Pick<CloudAgentInjected, 'hooks' | 'refresh'>>
  & PropsLocale<'company.cloudAgent'> & { readonly revealAgentInfo: (sessionId: SessionId) => void }
/** Caller-visible availability labels, independent of the Session's pinned release. */
export const usageStatuses: Record<CloudAgentUsageStatus, CloudAgentLocaleKey> = {
  available: 'statusAvailable', updated: 'statusUpdated', withdrawn: 'statusWithdrawn', deleted: 'statusDeleted',
  'access-lost': 'statusAccessLost', disabled: 'statusDisabled',
}

/** Open the information tab only in response to a user action.
 * @param props - scoped catalog and sidebar navigation.
 * @returns a navigation action for bound Agent conversations.
 */
export function CloudAgentInfoNavigation(props: NavigationProps) {
  const catalog = props.useCloudAgent(state => state.catalog)
  const bound = catalog?.conversations
    .some(item => item.sessionId === props.sessionId && item.agentId !== null && item.deletedAt === undefined)
  if (bound !== true) return null
  return <Button variant="ghost" icon={<IconInfoOutlineRegular />} onClick={() => { props.revealAgentInfo(props.sessionId) }}>{props.t('agentInfo')}</Button>
}

/** Show owner, release, creation/run modes and actual model selection, without endpoint or token examples.
 * @param props - scoped Session hooks and catalog refresh action.
 * @returns retained release metadata or an explicit unavailable state.
 */
export function CloudAgentInfo(props: PropsRuntime<'sidebar.right.pane.tab'> & Shared) {
  const view = props.useCloudAgent(state => state)
  const model = props.useProjection('modelSelection')
  const connected = connectedAgent(view.catalog, props.sessionId)
  if (view.catalog === null && view.loading) return <div className={css.infoLoading} role="status" aria-label={props.t('loading')}><StateDot state="ongoing" size={24} /></div>
  if (connected === undefined) return <section className={css.info}><p>{props.t('agentInfoUnavailable')}</p>
    <Button variant="outline" disabled={view.loading} onClick={() => { void props.refresh() }}>{props.t('retry')}</Button></section>
  const { release, conversation } = connected
  const used = view.catalog?.usage.find(item => item.agentId === connected.id)
  const status = used?.status ?? (connected.record?.deletedAt !== undefined ? 'deleted'
    : connected.record?.publishedReleaseId === null ? 'withdrawn' : 'available')
  const actual = model?.lastUsed ?? model?.next
  return <section className={css.info} data-cloud-agent-info={release.id}>
    {view.error !== null && <div role="alert" className={css.notice}><span>{props.t(view.error)}</span>
      <Button variant="outline" disabled={view.loading} onClick={() => { void props.refresh() }}>{props.t('retry')}</Button></div>}
    <header className={css.cardHeading}><h2>{release.definition.name}</h2><Tag>{release.kind === 'preview' ? props.t('preview') : props.t('version', { version: String(release.version) })}</Tag></header>
    <p className={css.description}>{release.definition.description}</p>
    <dl className={css.infoFields}>
      <div><dt>{props.t('owner')}</dt><dd>{connected.ownerId}</dd></div>
      <div><dt>{props.t('agentId')}</dt><dd>{connected.id}</dd></div>
      <div><dt>{props.t('releaseId')}</dt><dd>{release.id}</dd></div>
      <div><dt>{props.t('visibility')}</dt><dd>{props.t(release.visibility === 'private' ? 'privateVisibility' : 'publicVisibility')}</dd></div>
      <div><dt>{props.t('creationPreset')}</dt><dd>{conversation.creationPreset ?? release.source?.preset ?? props.t('notRecorded')}</dd></div>
      <div><dt>{props.t('runPreset')}</dt><dd>{conversation.runPreset ?? props.t('defaultPreset')}</dd></div>
      <div><dt>{props.t('provider')}</dt><dd>{actual?.provider ?? props.t('notRecorded')}</dd></div>
      <div><dt>{props.t('model')}</dt><dd>{actual?.model ?? props.t('notRecorded')}</dd></div>
      <div><dt>{props.t('status')}</dt><dd><Tag tone={status === 'available' || status === 'updated' ? 'success' : 'warning'}>{props.t(usageStatuses[status])}</Tag></dd></div>
      <div><dt>{props.t('digest')}</dt><dd>{release.digest ?? props.t('notRecorded')}</dd></div>
      <div><dt>{props.t('effectiveDigest')}</dt><dd>{conversation.effectiveDigest ?? props.t('notRecorded')}</dd></div>
    </dl>
    {release.source !== undefined && connected.record !== undefined && <Button variant="outline" onClick={() => {
      if (release.source !== undefined) props.openConversation(release.source.sessionId)
    }}>{props.t('sourceSession')}</Button>}
  </section>
}
