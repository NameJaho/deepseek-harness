/** Locale-owned authorization cards, recorded tool results and connection management. */
import { Button, IconWarningOutlineRegular, StateDot, Tag, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-company-cloud-agent/client'
import { z } from 'zod'
import type { WecomSnapshot } from '../types.ts'
import type { WecomInjected, WecomView } from './controller.ts'
import css from './views.module.css'

type Shared = InjectFace<WecomInjected> & PropsLocale<'company.wecom'>
type CardProps = ToolCallViewProps & Shared
type PageProps = PropsRuntime<'plugins.item'> & Shared
const statuses = z.enum(['connecting', 'online', 'offline', 'disabled'])
type Status = z.infer<typeof statuses>
const catalogResult = z.object({ agents: z.array(z.object({
  id: z.string().min(1), name: z.string(), revision: z.number().int().nonnegative(), publishedReleaseId: z.string().nullable(),
})) })
const statusResult = z.object({
  bindings: z.array(z.object({ id: z.string().min(1), name: z.string(), status: statuses })),
  requests: z.array(z.object({ id: z.string().min(1), name: z.string(), bindingId: z.string().nullable() })),
})
const tones: Record<Status, TagTone> = { online: 'success', connecting: 'info', disabled: 'neutral', offline: 'warning' }
const descriptions = {
  online: 'onlineDescription', connecting: 'connectingDescription', disabled: 'disabledDescription', offline: 'offlineDescription',
} as const

function parseResult(text: string): unknown {
  try { return JSON.parse(text) } catch (_error) { return undefined }
}

function uniqueIds(rows: readonly { id: string }[]): boolean {
  return new Set(rows.map(row => row.id)).size === rows.length
}

function StatusHeading({ name, status, t }: { name: string; status: Status } & Pick<Shared, 't'>) {
  return <div className={css.heading}><strong>{name}</strong><Tag tone={tones[status]}>{t(status)}</Tag></div>
}

function ViewNotice({ view, refresh, t }: { view: WecomView } & Pick<Shared, 'refresh' | 't'>) {
  return <div className={css.notice}>
    {view.authorizationUncertain !== null && <div role="alert" className={css.noticeLine}>
      <span>{t('authorization-uncertain')}</span>
      <Button variant="ghost" disabled={view.busy !== null} onClick={refresh}>{t('refresh')}</Button>
    </div>}
    {view.error !== null && <div role="alert" className={css.noticeLine}>
      <span>{t(view.error)}</span>
      <Button variant="ghost" disabled={view.busy !== null} onClick={refresh}>{t('retry')}</Button>
    </div>}
  </div>
}

function BindingCard({ binding, view, t, setEnabled }: {
  binding: WecomSnapshot['bindings'][number]
  view: WecomView
} & Pick<Shared, 't' | 'setEnabled'>) {
  const locked = view.busy !== null || view.error !== null
  return <article className={css.card}>
    <StatusHeading name={binding.name} status={binding.status} t={t} />
    <p>{t(descriptions[binding.status])}</p>
    <div className={css.actions}>
      <Button variant="outline" disabled={locked} onClick={() => { setEnabled(binding.id, !binding.enabled) }}>
        {t(binding.enabled ? 'disable' : 'enable')}</Button>
      {binding.enabled && binding.status === 'offline' && <Button variant="outline" disabled={locked}
        onClick={() => { setEnabled(binding.id, true) }}>{t('reconnect')}</Button>}
    </div>
  </article>
}

function PendingCard({ request, view, authorize, t }: {
  request: WecomSnapshot['requests'][number]
  view: WecomView
} & Pick<Shared, 'authorize' | 't'>) {
  return <article className={css.card} data-wecom-request={request.id}>
    <div className={css.heading}><strong>{request.name}</strong><Tag tone="warning">{t('unauthorized')}</Tag></div>
    <p>{t('awaiting')}</p>
    <div className={css.actions}><Button variant="primary"
      disabled={view.busy !== null || view.error !== null || view.authorizationUncertain !== null}
      onClick={() => { authorize(request.id) }}>{t('scan')}</Button></div>
  </article>
}

/** Render catalog/status from recorded results, and authorization from live credential-free state.
 * @param props - tool stage, shared routing state and authorization actions.
 * @returns meaningful recorded results or actual robot state; never a Secret from the authorization flow.
 */
export function WecomPublishCard(props: CardProps) {
  const view = props.useWecom(state => state)
  if (props.phase !== 'result') return <div className={css.loadingCard} role="status" aria-label={props.t('working')}>
    <StateDot state="ongoing" size={24} />
  </div>
  const block = props.block
  const text = block.content.filter(item => item.type === 'text').map(item => item.text).join('\n')
  const action = block.args.text('action')
  const payload = parseResult(text)
  if (!block.isError && action === 'catalog') {
    const parsed = catalogResult.safeParse(payload)
    if (parsed.success && uniqueIds(parsed.data.agents)) return <article className={css.card}>
      <h3>{props.t('catalog')}</h3>
      {parsed.data.agents.length === 0 ? <p>{props.t('catalogEmpty')}</p> : <ul className={css.list}>
        {parsed.data.agents.map(agent => <li key={agent.id} className={css.record}>
          <strong>{agent.name}</strong><dl className={css.metadata}>
            <div><dt>{props.t('agentId')}</dt><dd>{agent.id}</dd></div>
            <div><dt>{props.t('revision')}</dt><dd>{agent.revision}</dd></div>
            <div><dt>{props.t('published')}</dt><dd>{agent.publishedReleaseId ?? props.t('unpublished')}</dd></div>
          </dl>
        </li>)}
      </ul>}
    </article>
  }
  if (!block.isError && action === 'status') {
    const parsed = statusResult.safeParse(payload)
    if (parsed.success && uniqueIds(parsed.data.bindings) && uniqueIds(parsed.data.requests)) {
      const pending = parsed.data.requests.filter(request => request.bindingId === null)
      return <article className={css.card}>
        <h3>{props.t('status')}</h3><p>{props.t('recorded')}</p>
        {parsed.data.bindings.length === 0 && pending.length === 0 && <p>{props.t('statusEmpty')}</p>}
        <ul className={css.list}>
          {parsed.data.bindings.map(binding => <li key={binding.id} className={css.record}>
            <StatusHeading name={binding.name} status={binding.status} t={props.t} />
            <p>{props.t(descriptions[binding.status])}</p>
          </li>)}
        </ul>
        {pending.length > 0 && <div><h3>{props.t('pending')}</h3><ul className={css.list}>
          {pending.map(request => <li key={request.id} className={css.record}>
            <div className={css.heading}><strong>{request.name}</strong><Tag tone="warning">{props.t('unauthorized')}</Tag></div>
          </li>)}
        </ul></div>}
      </article>
    }
  }
  const meta = block.meta
  const id = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && 'wecomRequestId' in meta
    && typeof meta.wecomRequestId === 'string' ? meta.wecomRequestId : undefined
  if (!block.isError && id !== undefined) {
    const request = view.snapshot?.requests.find(item => item.id === id)
    const binding = view.snapshot?.bindings.find(item => item.requestId === id || item.id === request?.bindingId)
    return <div className={css.publication}>
      <ViewNotice view={view} refresh={props.refresh} t={props.t} />
      {binding !== undefined ? <BindingCard binding={binding} view={view} t={props.t} setEnabled={props.setEnabled} />
        : request !== undefined && request.bindingId === null
          ? <PendingCard request={request} view={view} authorize={props.authorize} t={props.t} />
          : view.snapshot === null && view.error === null ? <div className={css.loadingCard} role="status" aria-label={props.t('loading')}>
            <StateDot state="ongoing" size={24} />
          </div> : <div className={css.card}><p>{props.t('unavailable')}</p>
            <Button variant="ghost" disabled={view.busy !== null} onClick={props.refresh}>{props.t('refresh')}</Button></div>}
    </div>
  }
  return <article className={css.card}>
    <h3>{props.t('title')}</h3>
    {block.isError && <p role="alert">{props.t('toolFailed')}</p>}
    <pre className={css.raw}>{text}</pre>
    {props.inspect !== undefined && <Button variant="ghost" onClick={props.inspect}>{props.t('details')}</Button>}
  </article>
}

/** Manage pending authorizations and robot enablement without exposing credentials.
 * @param props - shared snapshot and connection actions.
 * @returns retained robot state with query Retry, or a centered shared spinner during initial load.
 */
export function WecomPage(props: PageProps) {
  const view = props.useWecom(state => state)
  if (props.view === 'summary') return props.t('description')
  const pending = view.snapshot?.requests.filter(request => request.bindingId === null) ?? []
  return <section className={css.page}>
    <ViewNotice view={view} refresh={props.refresh} t={props.t} />
    {view.snapshot === null ? view.error === null && <div className={css.loading} role="status" aria-label={props.t('loading')}>
      <StateDot state="ongoing" size={28} />
    </div> : <div className={css.grid}>
      {view.snapshot.bindings.length === 0 && pending.length === 0 && <p>{props.t('empty')}</p>}
      {view.snapshot.bindings.map(binding => <BindingCard key={binding.id} binding={binding}
        view={view} t={props.t} setEnabled={props.setEnabled} />)}
      {pending.map(request => <PendingCard key={request.id} request={request} view={view} authorize={props.authorize} t={props.t} />)}
    </div>}
  </section>
}

/** Manage only the robot channels bound to the release shown in the Agent sidebar.
 * @param props - exact saved release, sanitized channel state and authorization actions.
 * @returns release-scoped connection cards and an explicit scan-request action.
 */
export function WecomAgentChannel(props: PropsRuntime<'company.cloudAgent.page.release.actions'> & Shared) {
  const { record, release } = props
  const view = props.useWecom(state => state)
  const bindings = view.snapshot?.bindings.filter(item => item.agentId === record.id && item.releaseId === release.id) ?? []
  const pending = view.snapshot?.requests.filter(item => item.agentId === record.id && item.releaseId === release.id
    && item.bindingId === null && item.expiresAt > Date.now()) ?? []
  return <section className={css.publication}>
    <h3>{props.t('title')}</h3><p>{props.t('channelInstructions')}</p>
    <ViewNotice view={view} refresh={props.refresh} t={props.t} />
    {view.snapshot === null && view.error === null && <div className={css.loadingCard} role="status" aria-label={props.t('loading')}><StateDot state="ongoing" size={24} /></div>}
    {bindings.map(binding => <BindingCard key={binding.id} binding={binding} view={view} t={props.t} setEnabled={props.setEnabled} />)}
    {pending.map(request => <PendingCard key={request.id} request={request} view={view} t={props.t} authorize={props.authorize} />)}
    {props.release.kind === 'published' ? pending.length === 0 && <Button variant="outline"
      disabled={view.busy !== null || view.error !== null || view.snapshot === null || view.authorizationUncertain !== null}
      onClick={() => { props.requestRelease(record.id, release.id) }}>{props.t('requestScan')}</Button>
      : <p>{props.t('publishFirst')}</p>}
  </section>
}

/** Keep transient operation outcomes visible after the card or Plugins page unmounts.
 * @param props - shell-bound notice hook, dismissal and refresh actions, and localized copy.
 * @returns the existing Toast primitive, or nothing when no operation has settled.
 */
export function WecomToast(props: PropsRuntime<'shell.overlay'> & Shared) {
  const notice = props.useWecom(state => state.notice)
  const busy = props.useWecom(state => state.busy)
  if (notice === null) return null
  return <Toast key={notice.sequence} text={props.t(notice.key)}
    {...notice.success ? { tone: 'success' as const } : { icon: <IconWarningOutlineRegular /> }}
    {...notice.key === 'authorization-uncertain' && busy === null
      ? { actions: [{ label: props.t('refresh'), onClick: props.refresh }] } : {}}
    onDone={() => { props.dismissNotice(notice.sequence) }} />
}
