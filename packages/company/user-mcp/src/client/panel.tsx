/** Sidebar panel for choosing which user MCP servers the default Agent may use. */
import { useEffect, useState } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UserMcpPreferences } from '../types.ts'

type PanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'company.userMcp'>
  & InjectFace<{
    readonly load: () => Promise<UserMcpPreferences>
    readonly save: (selectedIds: readonly string[]) => Promise<UserMcpPreferences>
  }>

/** Local view state; the server copy is authoritative after each successful read or save. */
type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'failed'

/** Toggle one id in an immutable selection.
 * @param selected - current selected ids.
 * @param id - MCP id being toggled.
 * @param checked - whether the id should be selected.
 * @returns the new selection in its previous order.
 */
function toggle(selected: readonly string[], id: string, checked: boolean): string[] {
  return checked ? [...new Set([...selected, id])] : selected.filter(item => item !== id)
}

/** Render the member's catalog with a checkbox per server and a save action.
 * @param props - sidebar pane props with the injected load and save functions.
 * @returns the panel.
 */
export function UserMcpPanel(props: PanelProps) {
  const { t, load, save } = props
  const [entries, setEntries] = useState<UserMcpPreferences['entries']>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [status, setStatus] = useState<Status>('loading')

  const reload = (): void => {
    setStatus('loading')
    load().then((result) => {
      setEntries(result.entries)
      setSelected(result.selectedIds)
      setStatus('idle')
    }, () => { setStatus('failed') })
  }
  useEffect(reload, [])

  const persist = (): void => {
    setStatus('saving')
    save(selected).then((result) => {
      setEntries(result.entries)
      setSelected(result.selectedIds)
      setStatus('saved')
    }, () => { setStatus('failed') })
  }

  const busy = status === 'loading' || status === 'saving'
  const message = status === 'failed' ? t('failed') : status === 'saved' ? t('saved') : status === 'loading' ? t('loading') : undefined
  return <section aria-busy={busy}>
    <h3>{t('title')}</h3>
    <p>{t('help')}</p>
    {entries.length === 0 && status !== 'loading' ? <p>{t('empty')}</p> : null}
    {entries.map(entry => <div key={entry.id}>
      <Checkbox label={entry.displayName} checked={selected.includes(entry.id)} disabled={status === 'saving'}
        onChange={(checked: boolean) => { setSelected(toggle(selected, entry.id, checked)) }} />
      {entry.description === '' ? null : <p>{entry.description}</p>}
    </div>)}
    <p>{t('selected', { count: String(selected.length) })}</p>
    <div role="status">{message}</div>
    <Button variant="outline" disabled={busy} onClick={reload}>{t('refresh')}</Button>
    <Button disabled={busy} onClick={persist}>{status === 'saving' ? t('saving') : t('save')}</Button>
  </section>
}
