/** Company knowledge sources, test search and retrieved evidence. */
import { useState } from 'react'
import { Button, StateDot, Tag, useClipboardCopy } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CompanyKnowledgeHit, CompanyKnowledgeSource } from '../types.ts'
import type { KnowledgeFailure, KnowledgeInjected, KnowledgeOutcome, KnowledgeSourceStatus } from './controller.ts'
import type { KnowledgeLocaleKey } from './locales.ts'
import css from './page.module.css'

type Props = PropsRuntime<'plugins.item'> & PropsLocale<'company.knowledge'> & InjectFace<KnowledgeInjected>
type Translate = Props['t']

/** Evidence cards rendered before the list is expanded. */
export const INITIAL_VISIBLE_HITS = 3

const failureCopy: Record<Exclude<KnowledgeFailure, 'load'>, readonly [KnowledgeLocaleKey, KnowledgeLocaleKey]> = {
  search: ['searchFailedTitle', 'searchFailedBody'],
  timeout: ['timeoutTitle', 'timeoutBody'],
  changed: ['changedTitle', 'changedBody'],
}
const statusTones: Record<KnowledgeSourceStatus['kind'], TagTone> = { found: 'success', empty: 'warning', failed: 'danger' }

function SourceStatus({ status, t }: { readonly status: KnowledgeSourceStatus | undefined; readonly t: Translate }) {
  if (status === undefined) return <Tag tone="quiet">{t('statusNotTested')}</Tag>
  switch (status.kind) {
    case 'found': return <Tag tone={statusTones.found}>{t('statusFound', { count: String(status.hits) })}</Tag>
    case 'empty': return <Tag tone={statusTones.empty}>{t('statusEmpty')}</Tag>
    case 'failed': return <Tag tone={statusTones.failed}>{t('statusFailed')}</Tag>
  }
}

function SourceCard({ source, selected, status, disabled, onSelect, t }: {
  readonly source: CompanyKnowledgeSource
  readonly selected: boolean
  readonly status: KnowledgeSourceStatus | undefined
  readonly disabled: boolean
  readonly onSelect: () => void
  readonly t: Translate
}) {
  return <li>
    <button type="button" className={css.source} aria-pressed={selected} disabled={disabled} onClick={onSelect}
      data-company-knowledge-source={source.id}>
      <span className={css.sourceHeading}>
        <span className={css.sourceName}>{source.name}</span>
        <Tag tone={selected ? 'solid' : 'success'}>{t(selected ? 'sourceSelected' : 'sourceReady')}</Tag>
      </span>
      <span className={css.sourceDescription}>{source.description || t('noDescription')}</span>
      <span className={css.sourceStatus}><SourceStatus status={status} t={t} /></span>
    </button>
  </li>
}

function EvidenceCard({ hit, t }: { readonly hit: CompanyKnowledgeHit; readonly t: Translate }) {
  const [expanded, setExpanded] = useState(false)
  const copy = useClipboardCopy(`${hit.documentTitle}\n${hit.breadcrumb}\n\n${hit.content}`)
  const percent = Math.round(Math.min(1, Math.max(0, hit.score)) * 100)
  return <article className={css.hit} data-company-knowledge-hit={hit.chunkId}>
    <header className={css.hitHeading}>
      <div className={css.hitIdentity}>
        <h3>{hit.documentTitle}</h3>
        {hit.breadcrumb !== '' && <p className={css.breadcrumb}>{hit.breadcrumb}</p>}
      </div>
      <Button variant="outline" onClick={copy.onCopy}>{t(copy.copied ? 'copied' : 'copy')}</Button>
    </header>
    <div className={css.relevance}>
      <span>{t('relevance')} {hit.score.toFixed(2)}</span>
      <span className={css.meter} role="meter" aria-label={t('relevance')} aria-valuemin={0} aria-valuemax={1}
        aria-valuenow={hit.score}><span style={{ width: `${String(percent)}%` }} /></span>
    </div>
    <div className={expanded ? css.content : `${css.content} ${css.contentClamped}`}>{hit.content}</div>
    <Button variant="ghost" className={css.expand} aria-expanded={expanded} onClick={() => { setExpanded(value => !value) }}>
      {t(expanded ? 'collapse' : 'expand')}
    </Button>
  </article>
}

function Evidence({ outcome, sourceName, stale, t }: {
  readonly outcome: KnowledgeOutcome
  readonly sourceName: string
  readonly stale: boolean
  readonly t: Translate
}) {
  const [showAll, setShowAll] = useState(false)
  const { hits, totalHits, belowThreshold } = outcome.value
  const visible = showAll ? hits : hits.slice(0, INITIAL_VISIBLE_HITS)
  return <section className={css.evidence} aria-label={t('evidence')} data-stale={stale}>
    <header className={css.sectionHeading}>
      <h2>{t('evidence')}</h2>
      <p className={css.metadata}>{t('resultFor', { query: outcome.request.query, source: sourceName })}</p>
      <p className={css.metadata}>{t('resultCounts', { shown: String(hits.length), total: String(totalHits) })}</p>
      {belowThreshold > 0 && <p className={css.metadata}>{t('belowThreshold', { count: String(belowThreshold) })}</p>}
    </header>
    {stale && <p className={css.metadata}>{t('previousResult')}</p>}
    {hits.length === 0 ? <div className={css.state} data-state="empty">
      <h3>{t('noHitsTitle')}</h3><p>{t('noHitsBody')}</p>
    </div> : <>
      <ol className={css.hits}>{visible.map(hit => <li key={hit.chunkId}><EvidenceCard hit={hit} t={t} /></li>)}</ol>
      {hits.length > INITIAL_VISIBLE_HITS && <Button variant="outline" onClick={() => { setShowAll(value => !value) }}>
        {showAll ? t('showLess') : t('showMore', { count: String(hits.length - INITIAL_VISIBLE_HITS) })}
      </Button>}
    </>}
  </section>
}

/** Show approved sources and retrieved evidence without exposing upstream addresses, credentials or space ids.
 * @param props - framework-bound knowledge state and actions.
 * @returns the summary text or the full knowledge management page.
 */
export function KnowledgePage({ useCompanyKnowledge, refreshKnowledge, testKnowledge, cancelKnowledge, retryKnowledge, t, view }: Props) {
  const state = useCompanyKnowledge(value => value)
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  if (view === 'summary') return <span>{t('summary')}</span>
  const sources = state.catalog?.sources ?? []
  const sourceId = sources.some(source => source.id === selected) ? selected : sources[0]?.id ?? ''
  const maxChars = state.catalog?.maxQueryChars ?? 0
  const length = query.trim().length
  const tooLong = length > maxChars
  const canSearch = sourceId !== '' && length > 0 && !tooLong && !state.searching
  const sourceName = (id: string): string => sources.find(source => source.id === id)?.name ?? id
  const searchFailure = state.failure !== null && state.failure !== 'load' ? failureCopy[state.failure] : undefined
  return <section className={css.page} aria-busy={state.loading || state.searching}>
    <header className={css.heading}>
      <p className={css.subtitle}>{t('subtitle')}</p>
      <Button variant="outline" disabled={state.loading} onClick={() => { void refreshKnowledge() }}>{t('refresh')}</Button>
    </header>

    {state.catalog === null && state.loading && <div className={css.state} role="status" aria-label={t('loading')}>
      <StateDot state="ongoing" /><p>{t('loading')}</p>
    </div>}
    {state.catalog === null && !state.loading && state.failure === 'load' && <div className={css.state} data-state="failed" role="alert">
      <h2>{t('loadFailedTitle')}</h2><p>{t('loadFailedBody')}</p>
      <Button variant="primary" onClick={() => { void retryKnowledge() }}>{t('retry')}</Button>
    </div>}
    {state.catalog !== null && state.failure === 'load' && <p className={css.notice} role="alert">{t('refreshFailed')}</p>}
    {state.catalog !== null && sources.length === 0 && <div className={css.state} data-state="unconfigured">
      <h2>{t('unconfiguredTitle')}</h2><p>{t('unconfiguredBody')}</p>
    </div>}

    {sources.length > 0 && <>
      <section className={css.sources} aria-label={t('sources')}>
        <header className={css.sectionHeading}>
          <h2>{t('sources')}</h2><p className={css.metadata}>{t('sourcesCount', { count: String(sources.length) })}</p>
        </header>
        <ul className={css.sourceList}>{sources.map(source => <SourceCard key={source.id} source={source} t={t}
          selected={source.id === sourceId} status={state.statuses[source.id]}
          disabled={state.searching} onSelect={() => { setSelected(source.id) }} />)}</ul>
      </section>

      <form className={css.search} onSubmit={(event) => {
        event.preventDefault()
        if (canSearch) void testKnowledge({ sourceId, query: query.trim() })
      }}>
        <h2>{t('searchTitle')}</h2>
        <label className={css.field}>
          <span>{t('query')}</span>
          <textarea value={query} rows={3} placeholder={t('queryPlaceholder')} disabled={state.searching}
            aria-invalid={tooLong} onChange={(event) => { setQuery(event.target.value) }} />
        </label>
        <div className={css.searchFooter}>
          <span className={tooLong ? `${css.metadata} ${css.overLimit}` : css.metadata} aria-live="polite">
            {tooLong ? t('queryTooLong', { max: String(maxChars) }) : t('queryCount', { count: String(length), max: String(maxChars) })}
          </span>
          <span className={css.actions}>
            {state.searching && <Button variant="outline" onClick={cancelKnowledge}>{t('cancel')}</Button>}
            <Button type="submit" variant="primary" disabled={!canSearch}>{t(state.searching ? 'searching' : 'search')}</Button>
          </span>
        </div>
      </form>

      {searchFailure !== undefined && <div className={css.notice} data-state={state.failure} role="alert">
        <div><strong>{t(searchFailure[0])}</strong><p>{t(searchFailure[1])}</p></div>
        <Button variant="outline" disabled={state.searching} onClick={() => { void retryKnowledge() }}>{t('retry')}</Button>
      </div>}
      {state.result !== null && <Evidence key={`${state.result.request.sourceId}\u0000${state.result.request.query}`}
        outcome={state.result} sourceName={sourceName(state.result.request.sourceId)} stale={searchFailure !== undefined} t={t} />}
    </>}

    <footer className={css.hint}>{t('searchOnly')}</footer>
  </section>
}
