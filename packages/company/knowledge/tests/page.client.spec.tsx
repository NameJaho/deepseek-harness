// @vitest-environment jsdom
/** Knowledge page states, search form limits and evidence presentation. */
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '../src/client/index.ts'
import type { KnowledgeView } from '../src/client/controller.ts'
import { en, zh, type KnowledgeLocaleKey } from '../src/client/locales.ts'
import { INITIAL_VISIBLE_HITS, KnowledgePage } from '../src/client/page.tsx'
import type { CompanyKnowledgeCatalog, CompanyKnowledgeHit, KnowledgeChunkId, KnowledgeDocumentId } from '../src/types.ts'

type Props = ComponentProps<typeof KnowledgePage>

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const translate = (dict: Record<KnowledgeLocaleKey, string>): Props['t'] =>
  ((key: KnowledgeLocaleKey, params?: Record<string, string>) => Object.entries(params ?? {})
    .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), dict[key])) as Props['t']
const catalog: CompanyKnowledgeCatalog = { maxQueryChars: 10, sources: [
  { id: 'operations', name: 'Operations', description: 'Store manuals' },
  { id: 'policies', name: 'Policies', description: '' },
] }
const hit = (index: number, overrides: Partial<CompanyKnowledgeHit> = {}): CompanyKnowledgeHit => ({
  chunkId: brandString<KnowledgeChunkId>(`chunk-${String(index)}`), documentId: brandString<KnowledgeDocumentId>('manual'),
  documentTitle: `Manual ${String(index)}`, breadcrumb: 'Drawer > Power', content: `Passage ${String(index)}`, score: 0.875, ...overrides,
})
const base: KnowledgeView = { catalog, loading: false, searching: false, failure: null, result: null, lastRequest: null, statuses: {} }

function props(view: KnowledgeView, dict: Record<KnowledgeLocaleKey, string> = en) {
  return { t: translate(dict), view: 'page', useCompanyKnowledge: <T,>(select: (value: KnowledgeView) => T): T => select(view),
    refreshKnowledge: vi.fn(() => Promise.resolve()), testKnowledge: vi.fn(() => Promise.resolve()),
    cancelKnowledge: vi.fn(), retryKnowledge: vi.fn(() => Promise.resolve()) } as Props & Record<string, ReturnType<typeof vi.fn>>
}

const outcome = (hits: readonly CompanyKnowledgeHit[], extra: { totalHits?: number; belowThreshold?: number } = {}): KnowledgeView['result'] => ({
  request: { sourceId: 'operations', query: 'drawer' },
  value: { sourceId: 'operations', hits, returned: hits.length, totalHits: extra.totalHits ?? hits.length, belowThreshold: extra.belowThreshold ?? 0 },
})

describe.each([{ name: 'English', dict: en }, { name: 'Chinese', dict: zh }])('$name knowledge page', ({ dict }) => {
  const t = translate(dict)

  it('renders the summary text in the plugin list', () => {
    render(<KnowledgePage {...props(base, dict)} view="summary" />)
    expect(screen.getByText(dict.summary)).toBeTruthy()
  })

  it('distinguishes loading, load failure, refresh failure and an unconfigured deployment', () => {
    const { rerender } = render(<KnowledgePage {...props({ ...base, catalog: null, loading: true }, dict)} />)
    expect(screen.getByRole('status', { name: dict.loading })).toBeTruthy()
    const failed = props({ ...base, catalog: null, failure: 'load' }, dict)
    rerender(<KnowledgePage {...failed} />)
    const alert = screen.getByRole('alert')
    expect(within(alert).getByText(dict.loadFailedTitle)).toBeTruthy()
    fireEvent.click(within(alert).getByRole('button', { name: dict.retry }))
    expect(failed.retryKnowledge).toHaveBeenCalledOnce()
    rerender(<KnowledgePage {...props({ ...base, failure: 'load' }, dict)} />)
    expect(screen.getByRole('alert').textContent).toBe(dict.refreshFailed)
    const empty = props({ ...base, catalog: { sources: [], maxQueryChars: 10 } }, dict)
    rerender(<KnowledgePage {...empty} />)
    expect(screen.getByText(dict.unconfiguredTitle)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBe(null)
    expect(screen.getByText(dict.searchOnly)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: dict.refresh }))
    expect(empty.refreshKnowledge).toHaveBeenCalledOnce()
  })

  it('shows sources without upstream details and records each source status', () => {
    render(<KnowledgePage {...props({ ...base, statuses: { operations: { kind: 'found', hits: 2 }, policies: { kind: 'failed' } } }, dict)} />)
    expect(screen.getByText(t('sourcesCount', { count: '2' }))).toBeTruthy()
    const operations = screen.getByRole('button', { name: /Operations/ })
    expect(operations.getAttribute('aria-pressed')).toBe('true')
    expect(within(operations).getByText(dict.sourceSelected)).toBeTruthy()
    expect(within(operations).getByText(t('statusFound', { count: '2' }))).toBeTruthy()
    const policies = screen.getByRole('button', { name: /Policies/ })
    expect(within(policies).getByText(dict.noDescription)).toBeTruthy()
    expect(within(policies).getByText(dict.statusFailed)).toBeTruthy()
    fireEvent.click(policies)
    expect(policies.getAttribute('aria-pressed')).toBe('true')
    expect(within(policies).getByText(dict.sourceSelected)).toBeTruthy()
  })

  it('shows not-tested and empty source states', () => {
    render(<KnowledgePage {...props({ ...base, statuses: { policies: { kind: 'empty' } } }, dict)} />)
    expect(within(screen.getByRole('button', { name: /Operations/ })).getByText(dict.statusNotTested)).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /Policies/ })).getByText(dict.statusEmpty)).toBeTruthy()
  })

  it('submits the trimmed question for the selected source and blocks empty or overlong questions', () => {
    const page = props(base, dict)
    render(<KnowledgePage {...page} />)
    const submit = screen.getByRole('button', { name: dict.search })
    const input = screen.getByRole('textbox')
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.submit(input.closest('form')!)
    expect(page.testKnowledge).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: 'x'.repeat(11) } })
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(t('queryTooLong', { max: '10' }))).toBeTruthy()
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: /Policies/ }))
    fireEvent.change(input, { target: { value: '  drawer  ' } })
    expect(screen.getByText(t('queryCount', { count: '6', max: '10' }))).toBeTruthy()
    fireEvent.click(submit)
    expect(page.testKnowledge).toHaveBeenCalledWith({ sourceId: 'policies', query: 'drawer' })
  })

  it('offers cancellation and disables input while searching', () => {
    const page = props({ ...base, searching: true }, dict)
    render(<KnowledgePage {...page} />)
    expect(screen.getByRole('textbox')).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: dict.searching })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /Operations/ })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: dict.cancel }))
    expect(page.cancelKnowledge).toHaveBeenCalledOnce()
  })

  it.for([['search', 'searchFailedTitle'], ['timeout', 'timeoutTitle'], ['changed', 'changedTitle']] as const)(
    'keeps the previous result visible beside a %s failure', ([failure, title]) => {
      const page = props({ ...base, failure, result: outcome([hit(1)]) }, dict)
      render(<KnowledgePage {...page} />)
      const alert = screen.getByRole('alert')
      expect(within(alert).getByText(dict[title])).toBeTruthy()
      fireEvent.click(within(alert).getByRole('button', { name: dict.retry }))
      expect(page.retryKnowledge).toHaveBeenCalledOnce()
      const evidence = screen.getByRole('region', { name: dict.evidence })
      expect(evidence.getAttribute('data-stale')).toBe('true')
      expect(within(evidence).getByText(dict.previousResult)).toBeTruthy()
      expect(within(evidence).getByText('Manual 1')).toBeTruthy()
    })

  it('explains an empty result and the passages removed by the score threshold', () => {
    render(<KnowledgePage {...props({ ...base, result: outcome([], { totalHits: 4, belowThreshold: 2 }) }, dict)} />)
    const evidence = screen.getByRole('region', { name: dict.evidence })
    expect(evidence.getAttribute('data-stale')).toBe('false')
    expect(within(evidence).getByText(dict.noHitsTitle)).toBeTruthy()
    expect(within(evidence).getByText(t('resultFor', { query: 'drawer', source: 'Operations' }))).toBeTruthy()
    expect(within(evidence).getByText(t('resultCounts', { shown: '0', total: '4' }))).toBeTruthy()
    expect(within(evidence).getByText(t('belowThreshold', { count: '2' }))).toBeTruthy()
  })

  it('pages long result lists, expands passages and copies the cited evidence', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const hits = [1, 2, 3, 4, 5].map(index => hit(index, index === 2 ? { breadcrumb: '' } : {}))
    render(<KnowledgePage {...props({ ...base, result: outcome(hits) }, dict)} />)
    expect(screen.getAllByRole('article')).toHaveLength(INITIAL_VISIBLE_HITS)
    expect(screen.getAllByText('Drawer > Power')).toHaveLength(INITIAL_VISIBLE_HITS - 1)
    fireEvent.click(screen.getByRole('button', { name: t('showMore', { count: '2' }) }))
    expect(screen.getAllByRole('article')).toHaveLength(5)
    fireEvent.click(screen.getByRole('button', { name: dict.showLess }))
    expect(screen.getAllByRole('article')).toHaveLength(INITIAL_VISIBLE_HITS)
    const first = screen.getAllByRole('article')[0]!
    const meter = within(first).getByRole('meter', { name: dict.relevance })
    expect(meter.getAttribute('aria-valuenow')).toBe('0.875')
    expect((meter.firstElementChild as HTMLElement).style.width).toBe('88%')
    expect(within(first).getByText(`${dict.relevance} 0.88`)).toBeTruthy()
    const expand = within(first).getByRole('button', { name: dict.expand })
    expect(expand.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(within(first).getByRole('button', { name: dict.collapse }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(within(first).getByRole('button', { name: dict.copy }))
    await waitFor(() => { expect(within(first).getByRole('button', { name: dict.copied })).toBeTruthy() })
    expect(writeText).toHaveBeenCalledWith('Manual 1\nDrawer > Power\n\nPassage 1')
  })

  it('names a result whose source left the catalog by its id', () => {
    const result = outcome([hit(1)])
    render(<KnowledgePage {...props({ ...base, result: result && { ...result, request: { sourceId: 'retired', query: 'drawer' } } }, dict)} />)
    expect(screen.getByText(t('resultFor', { query: 'drawer', source: 'retired' }))).toBeTruthy()
  })
})
