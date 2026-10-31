/** Deployment capability discovery and immutable skill-resource capture. */
import { companyMcpFingerprint } from '@deepseek-ai/dsh-company-mcp-provider'
import { lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-company-mcp-provider'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from './config.ts'
import type { CloudAgentCapabilities, CloudAgentSkillSnapshot } from './types.ts'

/** Stable signature of the model-visible fields of a configured MCP tool.
 * @param schema - current registered tool schema.
 * @returns SHA-256 fingerprint; executable callbacks and credentials are excluded.
 */
export function toolFingerprint(schema: ToolSchema): string {
  return companyMcpFingerprint(schema)
}

/** Discover configured tools and invocable skills without exposing their credentials.
 * @param ctx - deployment-owned tool and skill registries.
 * @param preset - capability preset; omission selects the deployment default.
 * @returns selectable names and descriptions.
 */
export async function capabilityCatalog(ctx: Context, preset?: string): Promise<CloudAgentCapabilities> {
  await using lease = await ctx.agentPresets.acquireScope(preset)
  const skills = ctx.get('skills')
  const mcpServers = await ctx.companyMcpProvider.capabilityCatalog()
  const catalog = await ctx.companyMcpProvider.catalog()
  return {
    mcpTools: catalog.servers.filter(server => server.enabled && server.status === 'available')
      .flatMap(server => server.tools.map(tool => ({ name: tool.name, description: tool.description }))),
    mcpServers,
    skills: skills === undefined ? [] : (await skills.list({ cwd: process.cwd(), scope: lease.key }))
      .filter(skill => skill.invocation.modelInvocable).map(skill => ({ name: skill.name, description: skill.description })),
  }
}

/** Capture installed skill bodies and regular resource files within deployment limits.
 * @param ctx - owning deployment's skill provider registry.
 * @param names - validated selected skill names.
 * @param config - resource limits.
 * @returns immutable snapshots; missing skills, symlinks and exceeded limits reject publication.
 */
export async function snapshotSkills(ctx: Context, names: readonly string[], config: Config): Promise<CloudAgentSkillSnapshot[]> {
  await using lease = await ctx.agentPresets.acquireScope(config.capabilityPreset)
  const registry = ctx.get('skills')
  const snapshots: CloudAgentSkillSnapshot[] = []
  for (const name of names) {
    const skill = await registry?.get(name, { cwd: process.cwd(), scope: lease.key })
    if (skill === undefined || !skill.invocation.modelInvocable) throw unavailableCapability(name)
    let bytes = Buffer.byteLength(skill.content)
    const resources: { path: string; base64: string }[] = []
    const root = skill.resourceBase?.kind === 'directory' ? skill.resourceBase.path
      : skill.path === undefined ? undefined : dirname(skill.path)
    const visit = async (directory: string, relative: string): Promise<void> => {
      for (const entry of (await readdir(directory, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'SKILL.md') continue
        const path = join(directory, entry.name)
        const target = relative === '' ? entry.name : `${relative}/${entry.name}`
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) throw unavailableCapability(`${name}: linked resource ${target}`)
        if (stat.isDirectory()) await visit(path, target)
        else if (stat.isFile()) {
          if (resources.length >= config.skillMaxFiles || bytes + stat.size > config.skillMaxBytes) {
            throw unavailableCapability(`${name}: resource limit exceeded`)
          }
          const data = await readFile(path)
          bytes += data.length
          if (bytes > config.skillMaxBytes) throw unavailableCapability(`${name}: resource limit exceeded`)
          resources.push({ path: target, base64: data.toString('base64') })
        }
      }
    }
    if (bytes > config.skillMaxBytes) throw unavailableCapability(`${name}: instructions exceed resource limit`)
    if (root !== undefined) await visit(root, '')
    snapshots.push({ name, description: skill.description, content: skill.content, resources })
  }
  return snapshots
}

/** Build the capability-domain failure used by discovery, publication and execution.
 * @param name - missing or changed resource identifier.
 * @returns actionable structured failure without provider connection settings.
 */
export function unavailableCapability(name: string): RemoteError<'cloud-agent/capability-unavailable'> {
  return new RemoteError('cloud-agent/capability-unavailable',
    'A selected capability is missing, changed, or exceeds the deployment limits. Check its configuration and publish a new version.', { name })
}
