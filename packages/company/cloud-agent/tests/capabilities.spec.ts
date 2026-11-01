/** Published skill snapshots and durable MCP references retain exact selections. */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { capabilityCatalog, snapshotSkills, toolFingerprint } from '../src/capabilities.ts'
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

it('lists direct knowledge sources when no MCP provider is mounted', async () => {
  const ctx = new Context()
  ctx.provide('agentPresets', { acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => undefined }) } as never)
  ctx.provide('companyKnowledge', { sources: () => [{ id: 'operations', name: 'Operations', description: 'Approved' }] } as never)
  const catalog = await capabilityCatalog(ctx, { scope: 'scope', corpId: 'corp', sub: 'member' } as never)
  expect(catalog.mcpServers).toEqual([])
  expect(catalog.knowledgeSources).toEqual([{ id: 'operations', name: 'Operations', description: 'Approved' }])
})

it('keeps internal instruction packs out of the Agent skill catalog and draft snapshots', async (test) => {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SkillRegistry)
  ctx.provide('agentPresets', { acquireScope: async () => ({ key: {}, [Symbol.asyncDispose]: async () => undefined }) } as never)
  const internal = [
    { name: 'agent-experience', source: 'custom', path: '/repo/packages/preset/agent-preset/skills/agent-experience/SKILL.md' },
    { name: 'installed-internal', source: 'custom', path: '/srv/node_modules/@deepseek-ai/dsh-agent-preset/skills/internal/SKILL.md' },
    { name: 'review-rules', source: 'project-agents', path: '/repo/.agents/skills/review-rules/SKILL.md' },
    { name: 'user-internal', source: 'user-agents' },
    { name: 'bundled-internal', source: 'bundled' },
    { name: 'runtime-internal', source: 'runtime' },
    { name: 'custom-alias', source: 'custom', path: 'C:\\repo\\.agents\\skills\\internal\\SKILL.md' },
  ]
  for (const skill of internal) ctx.skills.register({ ...skill, description: 'Internal', content: 'Internal' })
  ctx.skills.register({ name: 'customer-policy', description: 'Customer', source: 'custom', content: 'Customer' })
  const catalog = await capabilityCatalog(ctx, { scope: 'scope', corpId: 'corp', sub: 'member' } as never)
  expect(catalog.skills).toEqual([{ name: 'customer-policy', description: 'Customer' }])
  const config = Config({ workspaceRoot: '/unused' } as Config)
  for (const skill of internal) {
    await expect(snapshotSkills(ctx, [skill.name], config)).rejects.toMatchObject({ code: 'cloud-agent/capability-unavailable' })
  }
  expect(await snapshotSkills(ctx, ['customer-policy'], config)).toMatchObject([{ name: 'customer-policy', content: 'Customer' }])
})
