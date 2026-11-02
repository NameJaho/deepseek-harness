/** Enterprise account action and popover at the existing sidebar footer. */
import { useState } from 'react'
import { Button, IconUserOutlineMedium, Menu, MenuItemButton, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './account.module.css'

/** Plain account summary and sign-out contributed by the login plugin. */
export interface AccountInjected {
  readonly displayName: string
  readonly userId: string
  readonly corpId: string
  readonly roleLabel: string
  /** Revoke the browser session and leave the app; rejects when the server refuses. */
  readonly signOut: () => Promise<void>
}

/** Existing footer geometry, localized label and account summary. */
export type AccountProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'company.wecomAuth'> & InjectFace<AccountInjected>

/** Show the enterprise identity above the footer action and sign out from it.
 * @param props - sidebar geometry, localized text, safe identity summary and sign-out.
 * @returns an accessible account action in wide and collapsed sidebars.
 */
export function WecomAccount({ wide, displayName, userId, corpId, roleLabel, signOut, t }: AccountProps) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const leave = async (): Promise<void> => {
    setPending(true)
    setFailed(false)
    try {
      await signOut()
    } catch (_refused) {
      // The session may still be valid; keep the popover open so the member can retry.
      setFailed(true)
      setPending(false)
    }
  }
  const rows: readonly [string, string][] = [[t('name'), displayName], [t('userId'), userId], [t('corpId'), corpId], [t('role'), roleLabel]]
  return <Menu
    open={open}
    onClose={() => { setOpen(false) }}
    side="top"
    portal
    className={css.popover}
    anchor={<Tooltip label={t('account')}>
      <Button
        className={css.action}
        data-wide={wide}
        variant="ghost"
        aria-label={t('account')}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <IconUserOutlineMedium size={16} />
        {wide && <span className={css.label}>
          <span>{displayName}</span>
          <small className={css.role}>{roleLabel}</small>
        </span>}
      </Button>
    </Tooltip>}
  >
    <div className={css.card}>
      <div className={css.title}>{t('account')}</div>
      <dl className={css.rows}>
        {rows.map(([label, value]) => <div key={label} className={css.row}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {failed && <p role="alert" className={css.error}>{t('failed')}</p>}
    </div>
    <MenuItemButton danger separatorBefore disabled={pending} onSelect={() => { void leave() }}>{t('logout')}</MenuItemButton>
  </Menu>
}
