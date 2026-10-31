/** Test-only app driver for the shipped profile plus the external provider overlay. */
import { resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import { bootProductionProfile } from '../../../../test-support/loader-smoke/tests/fixtures/production-profile.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('external agent fixture needs an overlay path')
const ctx = await bootProductionProfile({
  binName: 'external-agent-fixture', profile: 'headless',
  overlayPaths: [resolveConfigPath(configPath, undefined)],
})
try {
  const turn = await runFixtureTurn(ctx, { task: 'Delegate to the configured research agent.' })
  const parent = ctx.agents.roots().find(agent => agent.id === turn.sessionId)
  if (parent === undefined) throw new Error('external fixture parent is missing')
  await ctx.subagents.waitForChildren(parent)
  await parent.whenIdle()
  await ctx.sessions.flush(parent.session)
} finally {
  await ctx.fiber.dispose()
}
