import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SandboxUnsupportedPolicyError } from '@deepseek-ai/dsh-sandbox'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ContainerSandboxProvider from '../src/index.ts'
import type { Config } from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })) ) })

async function runtimeScript(exitCode = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-container-runtime-'))
  dirs.push(dir)
  const path = join(dir, 'runtime')
  await writeFile(path, `#!/bin/sh\nif [ "$1" = version ]; then exit ${String(exitCode)}; fi\n`, { mode: 0o755 })
  await chmod(path, 0o755)
  return path
}

async function provider(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-container-workspace-'))
  const readOnly = await mkdtemp(join(tmpdir(), 'dsh-container-readonly-'))
  dirs.push(root, readOnly)
  const runtime = await runtimeScript()
  const ctx = new Context()
  const config: Config = { runtime, image: 'node:24-bookworm', workspaceRoots: [root], readOnlyRoots: [readOnly], ...overrides }
  const service = new ContainerSandboxProvider(ctx, config, { probe: async () => undefined })
  return { root, readOnly, service }
}

const policy = (root: string, mode: 'read-only' | 'workspace-write' = 'workspace-write') => ({ mode, workspaceRoot: root, sessionId: SessionId('session-a') })

describe('container argv', () => {
  it('mounts only the selected workspace read-write and disables network/capabilities', async () => {
    const { root, readOnly, service } = await provider()
    const result = await service.confine(['/bin/bash', '-c', 'echo ok'], policy(root))
    expect(result.enforcement).toBe('full')
    expect(result.argv).toContain('--network=none')
    expect(result.argv).toContain('--cap-drop=ALL')
    expect(result.argv).toContain(`type=bind,src=${await realpath(readOnly)},dst=${await realpath(readOnly)},readonly`)
    expect(result.argv).toContain(`type=bind,src=${await realpath(root)},dst=/workspace,rw`)
    expect(result.argv.at(-4)).toBe('node:24-bookworm')
    expect(result.argv.at(-3)).toBe('/bin/bash')
  })

  it('mounts the workspace read-only and labels the Session', async () => {
    const { root, service } = await provider()
    const result = await service.confine(['node', '-e', '1'], policy(root, 'read-only'))
    expect(result.argv).toContain(`type=bind,src=${await realpath(root)},dst=/workspace,ro`)
    expect(result.argv).toContain('com.deepseek.dsh.session=session-a')
  })

  it('rejects a workspace outside the deployment allow-list', async () => {
    const { service } = await provider()
    const other = await mkdtemp(join(tmpdir(), 'dsh-container-other-'))
    dirs.push(other)
    await expect(service.confine(['true'], policy(other))).rejects.toThrow(SandboxUnsupportedPolicyError)
  })

  it('rejects extra writable roots instead of silently widening the mount set', async () => {
    const { root, service } = await provider()
    await expect(service.confine(['true'], { ...policy(root), additionalWritableRoots: ['/tmp'] })).rejects.toThrow('additional writable roots')
  })

  it('probes the configured runtime and reports an unavailable runtime', async () => {
    const { root, readOnly } = await provider()
    const runtime = await runtimeScript()
    const ctx = new Context()
    const service = new ContainerSandboxProvider(ctx, { runtime, image: 'node:24-bookworm', workspaceRoots: [root], readOnlyRoots: [readOnly], user: '1:1' })
    await service[Service.init]()
    const unavailable = new ContainerSandboxProvider(new Context(), { runtime, image: 'node:24-bookworm', workspaceRoots: [root], readOnlyRoots: [readOnly], user: '1:1' }, {
      probe: async () => { throw new Error('runtime offline') },
    })
    await expect(unavailable.confine(['true'], policy(root))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' })
  })

  it('rejects invalid execution requests before creating a container', async () => {
    const { root, service } = await provider()
    const controller = new AbortController()
    controller.abort()
    await expect(service.confine(['true'], policy(root), controller.signal)).rejects.toThrow()
    await expect(service.confine([], policy(root))).rejects.toThrow('argv')
    await expect(service.confine(['true'], { ...policy(root), workspaceRoot: '/' })).rejects.toThrow('must not be the host root')
    const empty = await provider({ workspaceRoots: [] })
    await expect(empty.service.confine(['true'], policy(empty.root))).rejects.toThrow('workspace')
    const file = join(root, 'file')
    await writeFile(file, 'x')
    await expect(service.confine(['true'], policy(file))).rejects.toThrow('workspaceRoot must be a directory')
    await expect(service.confine(['true'], policy(join(await realpath(root), 'missing')))).rejects.toThrow('workspace is unavailable')
  })

  it('requires a non-root default container identity', async () => {
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(0)
    const getgid = vi.spyOn(process, 'getgid').mockReturnValue(1000)
    try {
      const ctx = new Context()
      expect(() => new ContainerSandboxProvider(ctx, { image: 'node:24-bookworm', user: '' }, { probe: async () => undefined })).toThrow('non-root')
    } finally {
      getuid.mockRestore()
      getgid.mockRestore()
    }
  })

  it('validates image, runtime, roots, resource values and explicit user values', async () => {
    const cases: Array<[string, Partial<Config>]> = [
      ['image', { image: '' }], ['image whitespace', { image: 'node image' }],
      ['runtime', { image: 'node', runtime: '' }], ['runtime whitespace', { image: 'node', runtime: 'docker run' }],
      ['workspace root', { image: 'node', workspaceRoots: ['relative'] }],
      ['read-only root', { image: 'node', readOnlyRoots: ['relative'] }],
      ['workspace host root', { image: 'node', workspaceRoots: ['/'] }],
      ['read-only host root', { image: 'node', readOnlyRoots: ['/'] }],
      ['user', { image: 'node', user: '0:0' }], ['memory', { image: 'node', memory: 'x y' }],
      ['cpus', { image: 'node', cpus: 'x y' }],
    ]
    for (const [label, config] of cases) {
      const candidate: Config = { ...config, image: config.image ?? 'node', user: config.user ?? '1:1' }
      expect(() => new ContainerSandboxProvider(new Context(), candidate, { probe: async () => undefined }), label).toThrow()
    }
  })

  it('does not require a Session label for an agentless call', async () => {
    const { root, service } = await provider()
    const result = await service.confine(['true'], { mode: 'read-only', workspaceRoot: root })
    expect(result.argv).not.toContain('--label')
  })
})
