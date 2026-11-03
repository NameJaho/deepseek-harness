/** Browser composition: mounts the user MCP Remote; the selection pane is rendered by the Cloud Agent capabilities tab. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import remote from '@deepseek-ai/dsh-company-user-mcp/remote'

/** Mount the Remote namespace.
 * @param ctx - browser plugin lifecycle.
 * @returns teardown that releases the Remote namespace.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote)
  return async () => { await unmount() }
}
