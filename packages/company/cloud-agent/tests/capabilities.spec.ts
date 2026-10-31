/** Published skill snapshots and durable MCP references retain exact selections. */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { snapshotSkills, toolFingerprint } from '../src/capabilities.ts'
import { cloudAgentDomain } from '../src/storage.ts'

it('captures regular resources and rejects missing skills, links and exceeded resource limits', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-skill-snapshot-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry)
  ctx.provide('agentPresets', { acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => undefined }) } as never)
  await mkdir(join(root, 'references'))
  await writeFile(join(root, 'references', 'rules.txt'), 'Use natural weeks.')
  await writeFile(join(root, '.private'), 'EXCLUDED')
  ctx.skills.register({ name: 'weekly-report', description: 'Weekly report.', source: 'custom',
    content: 'Use references/rules.txt.', resourceBase: { kind: 'directory', path: root } })
  const config: Readonly<Config> = Config({ workspaceRoot: root } as Config)
  const snapshot = await snapshotSkills(ctx, ['weekly-report'], config)
  expect(snapshot[0]?.resources.map(resource => resource.path)).toEqual(['references/rules.txt'])
  await writeFile(join(root, 'references', 'rules.txt'), 'CHANGED')
  expect(Buffer.from(snapshot[0]?.resources[0]?.base64 ?? '', 'base64').toString()).toBe('Use natural weeks.')
  await expect(snapshotSkills(ctx, ['missing'], config)).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  await expect(snapshotSkills(ctx, ['weekly-report'], { ...config, skillMaxBytes: 1 }))
    .rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  if (process.platform !== 'win32') {
    await symlink(join(root, '.private'), join(root, 'references', 'linked'))
    await expect(snapshotSkills(ctx, ['weekly-report'], config)).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
    expect(await readFile(join(root, '.private'), 'utf8')).toBe('EXCLUDED')
  }
})

it('rejects unsafe skill paths and mismatched saved capability references', () => {
  const schema = cloudAgentDomain.tables.agents.valueSchema
  const draft = { name: 'Agent', description: '', instructions: 'Help.', provider: 'fixture', model: 'fixture' }
  const skill = { name: 'weekly-report', description: '', content: 'Report.', resources: [{ path: '../outside', base64: '' }] }
  const record = { id: '10000000-0000-4000-8000-000000000001', ownerId: 'owner', revision: 2, draft,
    releases: [{ id: '10000000-0000-4000-8000-000000000002', kind: 'published', version: 1, draftRevision: 1,
      definition: { ...draft, skills: ['weekly-report'] }, createdAt: 0, skillSnapshots: [skill] }],
    publishedReleaseId: '10000000-0000-4000-8000-000000000002', createdAt: 0, updatedAt: 0 }
  expect(schema.safeParse(record).success).toBe(false)
  skill.resources[0]!.path = 'rules.txt'
  expect(schema.safeParse(record).success).toBe(true)
  expect(schema.safeParse({ ...record, draftSkillSnapshots: [skill] }).success).toBe(false)
  expect(schema.safeParse({ ...record, draftMcpBindings: [{ name: 'mcp__sales__ping', fingerprint: 'a'.repeat(64) }] }).success).toBe(false)
  record.releases[0]!.skillSnapshots = []
  expect(schema.safeParse(record).success).toBe(false)
})

it('fingerprints the exact provider schema including tool descriptions and parameters', () => {
  const a = { name: 'mcp__sales__ping', description: 'Ping', parameters: { type: 'object', properties: { q: { type: 'string' } } } }
  expect(toolFingerprint(a)).toBe(toolFingerprint(structuredClone(a)))
  expect(toolFingerprint(a)).not.toBe(toolFingerprint({ ...a, description: 'Changed' }))
  expect(toolFingerprint(a)).not.toBe(toolFingerprint({ ...a, parameters: { type: 'object' } }))
})
