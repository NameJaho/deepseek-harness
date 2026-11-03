/** Default-conversation capabilities: choose which user MCP servers the default Agent may use. */
import { useEffect, useState } from 'react'
import { Button, Checkbox } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserMcpPreferences } from '@deepseek-ai/dsh-company-user-mcp/types'
import type { CloudAgentLocaleKey } from './locales.ts'
import css from './page.module.css'

/** Copy and the member's selection, supplied by the owning pane. */
export interface DefaultCapabilitiesProps {
  readonly t: (key: CloudAgentLocaleKey, params?: Record<string, string>) => string
  readonly load: () => Promise<UserMcpPreferences>
  readonly save: (selectedIds: readonly string[]) => Promise<UserMcpPreferences>
}

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
export function DefaultCapabilities(props: DefaultCapabilitiesProps) {
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
  const message = status === 'failed' ? t('defaultMcpFailed') : status === 'saved' ? t('defaultMcpSaved') : status === 'loading' ? t('defaultMcpLoading') : undefined
  return <section className={css.info} aria-busy={busy}>
    <h3 className={css.capabilityPickerTitle}>{t('defaultMcpTitle')}</h3>
    <p className={css.help}>{t('defaultMcpHelp')}</p>
    {entries.length === 0 && status !== 'loading' ? <p className={css.help}>{t('defaultMcpEmpty')}</p> : null}
    <div className={css.capabilityList}>
      {entries.map(entry => <div key={entry.id} className={css.capabilityOption}>
        <Checkbox label={entry.displayName} checked={selected.includes(entry.id)} disabled={status === 'saving'}
          onChange={(checked: boolean) => { setSelected(toggle(selected, entry.id, checked)) }} />
        {entry.description === '' ? null : <p className={css.capabilityDescription}>{entry.description}</p>}
      </div>)}
    </div>
    <div className={css.capabilityFooter}>
      <span className={css.metadata}>{t('defaultMcpSelected', { count: String(selected.length) })}</span>
      <span role="status" className={css.help}>{message}</span>
      <div className={css.actions}>
        <Button variant="outline" disabled={busy} onClick={reload}>{t('defaultMcpRefresh')}</Button>
        <Button disabled={busy} onClick={persist}>{status === 'saving' ? t('defaultMcpSaving') : t('defaultMcpSave')}</Button>
      </div>
    </div>
  </section>
}
