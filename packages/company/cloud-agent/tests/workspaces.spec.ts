/** Private Session directories carry pinned Skill resources without Docker ownership. */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionWorkspaces } from '../src/workspaces.ts'

it('prepares distinct private directories and removes only a failed workspace', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-workspaces-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const files = new SessionWorkspaces(root)
  const one = await files.workspace(SessionId('one'))
  const two = await files.workspace(SessionId('two'))
  expect(one).not.toBe(two)
  if (process.platform !== 'win32') expect((await stat(one)).mode & 0o777).toBe(0o700)
  await files.materializeSkills(SessionId('one'), [{ name: 'skill', description: '', content: 'Instructions',
    resources: [{ path: 'data.txt', base64: Buffer.from('resource').toString('base64') }] }])
  expect(await readFile(join(one, '.skills/skill/data.txt'), 'utf8')).toBe('resource')
  expect(await files.workspace(SessionId('one'))).toBe(one)
  await files.discardWorkspace(SessionId('two'))
  await expect(stat(two)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(one, '.skills/skill/SKILL.md'), 'utf8')).toBe('Instructions')
})

it('reuses one workspace for one Agent and owner across usage Sessions', async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'cloud-agent-workspaces-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const files = new SessionWorkspaces(root)
  const first = await files.agentWorkspace('agent-a', 'wecom:corp:alice')
  const second = await files.agentWorkspace('agent-a', 'wecom:corp:alice')
  const otherOwner = await files.agentWorkspace('agent-a', 'wecom:corp:bob')
  expect(second).toBe(first)
  expect(otherOwner).not.toBe(first)
})
