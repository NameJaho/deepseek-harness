/** Transport the private subprocess pipe across Docker's stdin/stdout attachment. */
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import type { Readable, Writable } from 'node:stream'
import { SUBPROCESS_CONTROL_ENV, SUBPROCESS_CONTROL_FD, openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control'

const execFileAsync = promisify(execFile)

/** Private launch fields emitted by the container provider. */
export interface ContainerInvocation {
  runtime: string
  timeoutMs: number
  options: string[]
  image: string
  nodeExecutable: string
  entry: string
  command: string[]
}

/**
 * Decode the private runner argument before starting any process.
 * @param text - serialized provider invocation.
 * @returns validated runner fields.
 */
export function parseInvocation(text: string): ContainerInvocation {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null
    || !('runtime' in value) || typeof value.runtime !== 'string'
    || !('timeoutMs' in value) || typeof value.timeoutMs !== 'number' || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0
    || !('image' in value) || typeof value.image !== 'string'
    || !('nodeExecutable' in value) || typeof value.nodeExecutable !== 'string'
    || !('entry' in value) || typeof value.entry !== 'string'
    || !('options' in value) || !Array.isArray(value.options) || !value.options.every((item: unknown) => typeof item === 'string')
    || !('command' in value) || !Array.isArray(value.command) || !value.command.every((item: unknown) => typeof item === 'string') || value.command.length === 0) {
    throw new Error('sandbox-container: invalid runner invocation')
  }
  return {
    runtime: value.runtime, timeoutMs: value.timeoutMs, image: value.image, nodeExecutable: value.nodeExecutable,
    entry: value.entry, options: value.options, command: value.command,
  }
}

/**
 * Attach Docker output to the inherited control pipe when requested and remove the container on exit.
 * @param invocation - provider-owned container arguments.
 * @returns container client exit status after cleanup.
 */
export async function runHost(invocation: ContainerInvocation): Promise<number> {
  const control = process.env[SUBPROCESS_CONTROL_ENV] === 'pipe' ? openInheritedControlChannel() : undefined
  const name = `dsh-${randomUUID()}`
  const args = [...invocation.options, '--name', name, '--interactive',
    '--entrypoint', invocation.nodeExecutable, invocation.image, invocation.entry,
    control === undefined ? 'plain' : 'control', JSON.stringify(invocation.command)]
  const child = spawn(invocation.runtime, args, { stdio: control === undefined ? 'inherit' : ['pipe', 'pipe', 'inherit'] })
  const forward = (signal: NodeJS.Signals): void => { child.kill(signal) }
  process.on('SIGTERM', forward)
  process.on('SIGINT', forward)
  const pipes = control === undefined ? [] : [pipeline(control, child.stdin as Writable), pipeline(child.stdout as Readable, control)]
  // The peer may close first during cancellation; settled pipes are joined below.
  for (const pipe of pipes) void pipe.catch(() => { child.kill('SIGTERM') })
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => { resolve(code ?? 1) })
    })
  } finally {
    control?.destroy()
    await Promise.allSettled(pipes)
    process.off('SIGTERM', forward)
    process.off('SIGINT', forward)
    try {
      await execFileAsync(invocation.runtime, ['rm', '--force', name], { timeout: invocation.timeoutMs })
    } catch (error) {
      // --rm normally removes the container before the explicit cancellation cleanup.
      if (!(error instanceof Error) || !/No such container|does not exist/u.test(error.message)) {
        process.stderr.write(`sandbox-container: container cleanup failed: ${String(error)}\n`)
      }
    }
  }
}

/**
 * Run the image's executable with a private fd 7 bridged to the attachment for PTC.
 * @param command - executable and literal arguments.
 * @param controlled - whether stdin/stdout carry the private control protocol.
 * @returns worker exit status after its streams close.
 */
export async function runGuest(command: string[], controlled: boolean): Promise<number> {
  const child = spawn(command[0] as string, command.slice(1), {
    env: { ...process.env, ...controlled ? { [SUBPROCESS_CONTROL_ENV]: 'pipe' } : {} },
    stdio: controlled ? ['ignore', 2, 2, 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'] : 'inherit',
  })
  const stop = (): void => { child.kill('SIGKILL') }
  if (controlled) {
    const streams: ReadonlyArray<Readable | Writable | null | undefined> = child.stdio
    const channel = streams[SUBPROCESS_CONTROL_FD]
    if (!channel || !('write' in channel) || !('read' in channel)) throw new Error('sandbox-container: worker control pipe is unavailable')
    process.stdin.pipe(channel)
    channel.pipe(process.stdout)
    process.stdin.once('end', stop)
    process.stdin.once('error', stop)
    channel.once('error', stop)
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => { resolve(code ?? 1) })
    })
  } finally {
    process.stdin.off('end', stop)
    process.stdin.off('error', stop)
    process.stdin.unpipe()
    process.stdin.pause()
  }
}
