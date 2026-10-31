/**
 * Container-backed process confinement. Each confined call starts a disposable
 * container with only the calling Session workspace mounted read/write; the
 * service process and every other user's workspace stay outside that mount.
 * @module @deepseek-ai/dsh-sandbox-container
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { SandboxProvider, SandboxUnavailableError, SandboxUnsupportedPolicyError, canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

const execFileAsync = promisify(execFile)

/** Deployment settings for the container runtime and its resource budget. */
export interface Config {
  /** Container runtime executable, normally `docker` or `podman`. */
  runtime?: string
  /** Image containing the command executables used by the selected profile. */
  image: string
  /** Physical deployment roots under which Session workspaces must exist. */
  workspaceRoots?: string[]
  /** Host roots mounted read-only so the container can run the shipped runtime. */
  readOnlyRoots?: string[]
  /** Container memory limit accepted by the runtime, for example `1g`. */
  memory?: string
  /** Container CPU quota accepted by the runtime, for example `2`. */
  cpus?: string
  /** Maximum number of processes in one container. */
  pidsLimit?: number
  /** Numeric uid:gid used inside the container; empty uses the non-root service uid:gid. */
  user?: string
  /** Runtime probe timeout in milliseconds. */
  probeTimeoutMs?: number
}

type ResolvedConfig = Required<Config>

/** Runtime probe hook used by tests and deployment diagnostics. */
export interface ContainerSandboxInternals {
  /** Resolve the runtime version; a rejected promise means the runtime is unavailable. */
  probe?: (runtime: string, timeoutMs: number) => Promise<void>
}

function validateRoot(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error(`sandbox-container: ${label} must be an absolute path without NUL bytes`)
  const resolved = resolve(path)
  if (resolved === '/') throw new Error(`sandbox-container: ${label} must not be the host root`)
  return resolved
}

function isUnder(path: string, root: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${path.includes('\\') ? '\\' : '/'}`) && !isAbsolute(suffix))
}

function validateImage(image: string): string {
  if (image.trim() === '' || /\s/u.test(image) || image.includes('\0')) throw new Error('sandbox-container: image must be a non-empty image reference without whitespace')
  return image
}

function validateRuntime(runtime: string): string {
  if (runtime.trim() === '' || /\s/u.test(runtime) || runtime.includes('\0')) throw new Error('sandbox-container: runtime must be an executable name or path without whitespace')
  return runtime
}

function validateUser(user: string): string {
  if (!/^[1-9][0-9]*:[1-9][0-9]*$/u.test(user)) throw new Error('sandbox-container: user must be a non-root numeric uid:gid pair')
  return user
}

function processUser(): string {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid === undefined || gid === undefined || uid === 0 || gid === 0) {
    throw new Error('sandbox-container: run the DSH service as a dedicated non-root user or configure a non-root container user with writable workspace ownership')
  }
  return `${String(uid)}:${String(gid)}`
}

/**
 * Runs each confined command in a disposable, networkless container.
 * The workspace allow-list is mandatory at runtime so a malformed Session cwd
 * cannot turn the bind mount into a host-root disclosure.
 */
export class ContainerSandboxProvider extends SandboxProvider {
  static Config: schema<Config, ResolvedConfig> = schema.object({
    runtime: schema.string().default('docker'),
    image: schema.string().required(),
    workspaceRoots: schema.array(schema.string()).default([]),
    readOnlyRoots: schema.array(schema.string()).default([]),
    memory: schema.string().default('1g'),
    cpus: schema.string().default('2'),
    pidsLimit: schema.natural().min(1).default(256),
    user: schema.string().default(''),
    probeTimeoutMs: schema.natural().min(1).default(5000),
  })

  static inject = []

  private readonly config: ResolvedConfig
  private readonly allowedRoots: readonly string[]
  private readonly readOnlyRoots: readonly string[]
  private readonly probe: (runtime: string, timeoutMs: number) => Promise<void>
  /** Settles when the runtime probe succeeds; rejects when the runtime is unavailable. */
  readonly ready: Promise<void>

  /** @param ctx - Cordis owner of the `ctx.sandbox` service. @param config - container runtime and isolation settings. */
  constructor(ctx: import('@deepseek-ai/cordis').Context, config: Config, internals: ContainerSandboxInternals = {}) {
    super(ctx)
    const resolved = ContainerSandboxProvider.Config(config)
    this.config = {
      ...resolved,
      runtime: validateRuntime(resolved.runtime),
      image: validateImage(resolved.image),
      memory: resolved.memory.trim(),
      cpus: resolved.cpus.trim(),
      user: validateUser(resolved.user === '' ? processUser() : resolved.user),
    }
    if (this.config.memory === '' || /\s/u.test(this.config.memory)) throw new Error('sandbox-container: memory must be a non-empty runtime value without whitespace')
    if (this.config.cpus === '' || /\s/u.test(this.config.cpus)) throw new Error('sandbox-container: cpus must be a non-empty runtime value without whitespace')
    this.allowedRoots = Object.freeze(this.config.workspaceRoots.map(path => canonicalPath(validateRoot(path, 'workspaceRoots entry'))))
    this.readOnlyRoots = Object.freeze(this.config.readOnlyRoots.map(path => canonicalPath(validateRoot(path, 'readOnlyRoots entry'))))
    this.probe = internals.probe ?? (runtime => execFileAsync(runtime, ['version'], { timeout: this.config.probeTimeoutMs }).then(() => undefined))
    /* v8 ignore next 3 -- the rejection continuation is exercised by the
     * unavailable-runtime test; V8 attributes this async throw to the generated
     * Promise continuation. */
    this.ready = this.probe(this.config.runtime, this.config.probeTimeoutMs).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      throw new SandboxUnavailableError('read-only', `container runtime ${JSON.stringify(this.config.runtime)} is unavailable: ${detail}`)
    })
  }

  /** Verify the configured runtime before the service becomes available. */
  async [Service.init](): Promise<void> { await this.ready }

  /**
   * Return a Docker/Podman argv that runs exactly one command in a disposable container.
   * @param argv - executable and arguments to run inside the image.
   * @param policy - resolved confined policy for the calling Session.
   * @param signal - cancellation before the container is handed to the subprocess provider.
   * @returns enforcing container argv with full enforcement facts.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    await this.ready
    signal?.throwIfAborted()
    if (argv.length === 0) throw new SandboxUnsupportedPolicyError('sandbox-container: argv must contain an executable')
    if (policy.additionalWritableRoots !== undefined && policy.additionalWritableRoots.length > 0) {
      throw new SandboxUnsupportedPolicyError('sandbox-container: additional writable roots are not supported; mount one Session workspace per call')
    }
    const workspace = canonicalPath(validateRoot(policy.workspaceRoot, 'workspaceRoot'))
    if (workspace === '/' || this.allowedRoots.length === 0 || !this.allowedRoots.some(root => isUnder(workspace, root))) {
      throw new SandboxUnsupportedPolicyError(`sandbox-container: workspace ${JSON.stringify(workspace)} is outside the configured workspaceRoots`)
    }
    const workspaceStat = await stat(workspace).catch((error: unknown) => { throw new SandboxUnsupportedPolicyError(`sandbox-container: workspace is unavailable: ${String(error)}`) })
    if (!workspaceStat.isDirectory()) throw new SandboxUnsupportedPolicyError('sandbox-container: workspaceRoot must be a directory')

    const mountMode = policy.mode === 'read-only' ? ',readonly' : ''
    const wrapped: string[] = [
      this.config.runtime, 'run', '--rm', '--init', '--network=none', '--read-only',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--pids-limit', String(this.config.pidsLimit), '--memory', this.config.memory, '--cpus', this.config.cpus,
      '--user', this.config.user,
    ]
    for (const root of this.readOnlyRoots) wrapped.push('--mount', `type=bind,src=${root},dst=${root},readonly`)
    wrapped.push('--mount', `type=bind,src=${workspace},dst=/workspace${mountMode}`, '--workdir', '/workspace')
    if (policy.sessionId !== undefined) wrapped.push('--label', `com.deepseek.dsh.session=${policy.sessionId}`)
    wrapped.push(this.config.image, ...argv)
    return {
      argv: wrapped,
      enforcement: 'full',
      denialSignatures: ['read-only file system', 'permission denied', 'operation not permitted', 'read-only filesystem'],
      runnerFailureRules: [{ fatalSignatures: ['Unable to find image', 'pull access denied', 'Cannot connect to the Docker daemon', 'permission denied while trying to connect to the Docker daemon'] }],
    }
  }
}

export default ContainerSandboxProvider
