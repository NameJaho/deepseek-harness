import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex, Readable, Writable } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Sessions from '@deepseek-ai/dsh-session'
import FileSystem from '@deepseek-ai/dsh-fs-local'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import ContainerSandbox from '../src/index.ts'
import { parseInvocation } from '../src/runner.ts'
import type { ContainerInvocation } from '../src/runner.ts'

const entry = fileURLToPath(new URL('../src/runner-entry.ts', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))

async function invocation(command: string[]): Promise<ContainerInvocation> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-container-relay-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const runtime = join(root, 'runtime')
  await writeFile(runtime, `#!${process.execPath}\n${await readFile(fixture, 'utf8')}`, { mode: 0o700 })
  return { runtime, timeoutMs: 5000, options: ['run'], image: 'fixture', nodeExecutable: process.execPath, entry, command }
}

describe.skipIf(process.platform === 'win32')('container pipe relay', () => {
  it('runs PTC calculations and host binding calls through the Docker attachment', async () => {
    const request = await invocation(['unused'])
    const root = await mkdtemp(join(tmpdir(), 'dsh-container-ptc-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
    await ctx.plugin(Sessions)
    await ctx.plugin(FileSystem)
    await ctx.plugin(Subprocess)
    await ctx.plugin(ContainerSandbox, { runtime: request.runtime, image: 'fixture', user: '1:1', nodeExecutable: process.execPath, workspaceRoots: [root] })
    await ctx.plugin(SessionProjections)
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: root })
    await ctx.plugin(NodeRuntime, {})
    const calculate = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ cwd: root, program: 'return 1 + 1', bindings: [] }))
    expect(calculate.error).toBeUndefined()
    expect(calculate.value).toBe(2)
    const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
      cwd: root, program: 'console.log("retrieving"); return await cloud_agent.catalog({})',
      bindings: [{ global: 'cloud_agent', functions: { catalog: async () => ({ sources: ['approved'] }) } }],
    }))
    expect(result.error).toBeUndefined()
    expect(result.value).toEqual({ sources: ['approved'] })
    expect(result.logs).toEqual(['retrieving'])
    const entered = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const pending = ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
      cwd: root, signal: controller.signal, program: 'await tools.enter({}); await new Promise(() => {})',
      bindings: [{ global: 'tools', functions: { enter: async () => { entered.resolve(undefined); return null } } }],
    }))
    await entered.promise
    controller.abort('stop container worker')
    expect((await pending).error).toMatchObject({ kind: 'abort' })
  })

  it('carries worker-first readiness and bidirectional control separately from diagnostics', async () => {
    const code = 'const {Socket}=require("node:net");const s=new Socket({fd:7,readable:true,writable:true});console.log("diagnostic");s.write("ready\\n");s.once("data",b=>{s.end(String(Number(b)*2));});'
    const request = await invocation([process.execPath, '-e', code])
    const child = spawn(process.execPath, [entry, 'host', JSON.stringify(request)], {
      env: { ...process.env, DSH_SUBPROCESS_CONTROL: 'pipe' },
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
    })
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    onTestFinished(async () => { child.kill('SIGKILL'); await closed })
    const streams: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio
    const control = streams[7] as Duplex
    let stdout = ''
    let stderr = ''
    let response = ''
    child.stdout!.on('data', (chunk: Buffer) => { stdout += String(chunk) })
    child.stderr!.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    control.on('data', (chunk: Buffer) => {
      response += String(chunk)
      if (response === 'ready\n') control.write('21')
    })
    await closed
    expect(response).toBe('ready\n42')
    expect(stdout).toBe('')
    expect(stderr).toContain('diagnostic')
  })

  it('preserves ordinary command output and status without a control pipe', async () => {
    const request = await invocation([process.execPath, '-e', 'console.log(1+1);process.exitCode=7'])
    const child = spawn(process.execPath, [entry, 'host', JSON.stringify(request)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk) })
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    onTestFinished(async () => { child.kill('SIGKILL'); await closed })
    expect(await closed, stderr).toBe(7)
    expect(stdout.trim()).toBe('2')
  })

  it('kills the guest worker when the host closes its control attachment', async () => {
    const code = 'const {Socket}=require("node:net");const s=new Socket({fd:7,readable:true,writable:true});s.write(String(process.pid));setInterval(()=>{},1000)'
    const request = await invocation([process.execPath, '-e', code])
    const child = spawn(process.execPath, [entry, 'host', JSON.stringify(request)], {
      env: { ...process.env, DSH_SUBPROCESS_CONTROL: 'pipe' },
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
    })
    const closed = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
    onTestFinished(async () => { child.kill('SIGKILL'); await closed })
    const streams: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio
    const control = streams[7] as Duplex
    const pid = await new Promise<number>((resolve) => { control.once('data', (chunk: Buffer) => { resolve(Number(String(chunk))) }) })
    control.end()
    await closed
    expect(() => process.kill(pid, 0)).toThrow()
  })
})

it('rejects malformed runner arguments before starting a process', () => {
  expect(() => parseInvocation('{}')).toThrow('invalid runner invocation')
})
