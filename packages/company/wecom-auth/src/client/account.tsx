/** Enterprise account action at the existing sidebar footer. */
import { Button, IconUserOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './account.module.css'

/** Plain account label and navigation contributed by the login plugin. */
export interface AccountInjected {
  readonly displayName: string
  readonly roleLabel: string
  readonly openAccount: () => void
}

/** Existing footer geometry, localized label and account navigation. */
export type AccountProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'company.wecomAuth'> & InjectFace<AccountInjected>

/** Open the browser's enterprise account and local sign-out page.
 * @param props - sidebar geometry, localized text and safe identity summary.
 * @returns an accessible account action in wide and collapsed sidebars.
 */
export function WecomAccount({ wide, displayName, roleLabel, openAccount, t }: AccountProps) {
  return <Tooltip label={t('account')}>
    <Button
      className={css.action}
      data-wide={wide}
      variant="ghost"
      aria-label={t('account')}
      onClick={openAccount}
    >
      <IconUserOutlineMedium size={16} />
      {wide && <span className={css.label}>
        <span>{displayName}</span>
        <small className={css.role}>{roleLabel}</small>
      </span>}
    </Button>
  </Tooltip>
}
