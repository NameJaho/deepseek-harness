/** Validated persistent definitions; draft, release and publication writes share one record. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CompanyMcpId } from '@deepseek-ai/dsh-company-mcp-provider/types'
import type { CloudAgentConversation, CloudAgentDraft, CloudAgentId, CloudAgentOwnerId, CloudAgentRecord, CloudAgentReleaseId } from './types.ts'

/** Structured authoring fields accepted from browsers and durable storage. */
export const draftSchema: z.ZodType<CloudAgentDraft> = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500),
  instructions: z.string().min(1).max(32768).refine(value => value.trim().length > 0),
  provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  mcpTools: z.array(z.string().regex(/^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/)).max(100).optional(),
  mcpServers: z.array(z.string().trim().min(1).max(200).transform(value => brandString<CompanyMcpId>(value))).max(100).optional(),
  skills: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(20).optional(),
}).strict()

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const sessionId = z.string().min(1).transform(value => brandString<SessionId>(value))
const releaseId = z.uuid().transform(value => brandString<CloudAgentReleaseId>(value))
const mcpBindingsSchema = z.array(z.object({ name: z.string().min(1), fingerprint: sha256 }).strict())
const skillSnapshotsSchema = z.array(z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string(), content: z.string(),
  resources: z.array(z.object({
    path: z.string().min(1).refine(value => !value.startsWith('/') && !value.includes('\\')
      && value.split('/').every(part => part !== '..' && part !== '.' && part !== '')),
    base64: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }).strict()),
}).strict())
const releaseSchema = z.object({
  id: releaseId,
  kind: z.enum(['published', 'preview']),
  version: z.number().int().nonnegative(),
  draftRevision: z.number().int().positive(),
  definition: draftSchema,
  createdAt: z.number().int().nonnegative(),
  mcpBindings: mcpBindingsSchema.optional(),
  capabilityPreset: z.string().min(1).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  source: z.object({ sessionId, throughSeq: z.number().int().nonnegative(),
    preset: z.string().min(1).optional(), permission: z.string().min(1).optional() }).strict().optional(),
  digest: sha256.optional(),
  skillSnapshots: skillSnapshotsSchema.optional(),
}).strict()

const recordSchema: z.ZodType<CloudAgentRecord> = z.object({
  id: z.uuid().transform(value => brandString<CloudAgentId>(value)),
  ownerId: z.string().min(1).transform(value => brandString<CloudAgentOwnerId>(value)),
  revision: z.number().int().positive(),
  draft: draftSchema,
  draftMcpBindings: mcpBindingsSchema.optional(),
  draftSkillSnapshots: skillSnapshotsSchema.optional(),
  draftCapabilityPreset: z.string().min(1).optional(),
  releases: z.array(releaseSchema),
  publishedReleaseId: releaseId.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  deletedAt: z.number().int().nonnegative().optional(),
  sourceSessionId: sessionId.optional(),
  sourceThroughSeq: z.number().int().nonnegative().optional(),
  lastAuthoringRequestId: z.string().min(1).optional(),
}).strict().superRefine((record, context) => {
  const ids = new Set(record.releases.map(release => release.id))
  const published = record.releases.filter(release => release.kind === 'published')
  const invalidRelease = record.releases.some((release) => {
    const tools = (release.mcpBindings ?? []).map(item => item.name).toSorted()
    const skills = (release.skillSnapshots ?? []).map(item => item.name).toSorted()
    return release.draftRevision > record.revision
      || (release.kind === 'published' ? release.version < 1 : release.version !== 0)
      || JSON.stringify(tools) !== JSON.stringify([...(release.definition.mcpTools ?? [])].sort())
      || JSON.stringify(skills) !== JSON.stringify([...(release.definition.skills ?? [])].sort())
  })
  const invalidDraft = (record.draftMcpBindings !== undefined
    && JSON.stringify(record.draftMcpBindings.map(item => item.name).sort()) !== JSON.stringify([...(record.draft.mcpTools ?? [])].sort()))
    || (record.draftSkillSnapshots !== undefined
      && JSON.stringify(record.draftSkillSnapshots.map(item => item.name).sort())
        !== JSON.stringify([...(record.draft.skills ?? [])].sort()))
  if (invalidDraft || ids.size !== record.releases.length
    || (record.deletedAt !== undefined && record.publishedReleaseId !== null)
    || new Set(published.map(release => release.version)).size !== published.length
    || invalidRelease
    || (record.publishedReleaseId !== null && !published.some(release => release.id === record.publishedReleaseId))) {
    context.addIssue({ code: 'custom', message: 'Cloud Agent release references or versions are invalid' })
  }
})

const conversationSchema: z.ZodType<CloudAgentConversation> = z.object({
  sessionId,
  agentId: z.uuid().transform(value => brandString<CloudAgentId>(value)).nullable(),
  role: z.enum(['authoring', 'usage']),
  releaseId: releaseId.optional(),
  ownerId: z.string().min(1).transform(value => brandString<CloudAgentOwnerId>(value)).optional(),
  deletedAt: z.number().int().nonnegative().optional(),
  creationPreset: z.string().min(1).optional(),
  runPreset: z.string().min(1).optional(),
  effectiveDigest: sha256.optional(),
}).strict().refine(value => value.role === 'authoring' ? value.releaseId === undefined : value.agentId !== null,
  'Usage conversations require an Agent; editing conversations cannot pin a release')
  .refine(value => value.deletedAt === undefined || (value.role === 'authoring' && value.agentId === null),
    'Only unbound editing conversations can retain a deletion marker')

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { companyCloudAgentBinding: CloudAgentConversation | null }
}

/** Latest immutable Session binding; constant-space recovery preserves the fork's original owner. */
export const cloudAgentBindingProjection = {
  key: 'companyCloudAgentBinding', stateVersion: 1,
  stateSchema: conversationSchema.nullable(),
  init: (): CloudAgentConversation | null => null,
  apply: (state, event) => event.type === 'cloud-agent/binding' ? event.data : state,
} satisfies import('@deepseek-ai/dsh-session-projection').ProjectionDefinition<'companyCloudAgentBinding', CloudAgentConversation | null>

/** Validate a recovered binding before copying it into durable navigation membership.
 * @param value - restored projection state from its checkpoint.
 * @returns the latest binding or null when no binding was recorded.
 */
export function recoveredBinding(value: unknown): CloudAgentConversation | null { return conversationSchema.nullable().parse(value) }

/** Invalid records stop activation rather than silently removing public agents. */
export const cloudAgentDomain = defineDomain({
  name: 'company_cloud_agent',
  version: 1,
  tables: { agents: domainTable<CloudAgentId, CloudAgentRecord>(recordSchema),
    conversations: domainTable<SessionId, CloudAgentConversation>(conversationSchema) },
})
