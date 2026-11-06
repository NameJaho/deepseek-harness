/** Browser half: hide dsh-context entries that the product does not expose. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { HIDDEN_CSS } from './styles.ts'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-dsh-context-hidden-entries'

/**
 * Append one style element that hides the dsh-context entries; disposing the
 * registration removes it.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.textContent = HIDDEN_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-context hidden entries: stylesheet')
}
