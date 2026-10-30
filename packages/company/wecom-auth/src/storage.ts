/** Durable login states, member identities and sessions; credentials have their own provider. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { WecomCorpId, WecomIdentityId, WecomLoginAttemptId, WecomSessionId, WecomUserId } from './types.ts'

const identityId = z.string().regex(/^i-[a-f0-9]{64}$/).transform(value => brandString<WecomIdentityId>(value))
const attemptId = z.uuid().transform(value => brandString<WecomLoginAttemptId>(value))
const sessionId = z.string().regex(/^s-[a-f0-9-]{36}$/).transform(value => brandString<WecomSessionId>(value))
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const corpId = z.string().min(1).transform(value => brandString<WecomCorpId>(value))
const userId = z.string().min(1).transform(value => brandString<WecomUserId>(value))

const identity = z.object({
  id: identityId, corpId, userId,
  displayName: z.string().min(1).optional(),
  departments: z.array(z.string()),
  enabled: z.boolean(),
  lastLoginAt: timestamp,
}).strict()

const attempt = z.object({
  id: attemptId,
  stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  browserHash: z.string().regex(/^[a-f0-9]{64}$/),
  corpId, agentId: z.string().min(1),
  expiresAt: timestamp,
  redirectPath: z.string().startsWith('/'),
  browserAuthority: z.string().min(1),
  createdAt: timestamp,
  consumedAt: timestamp.optional(),
}).strict()

const session = z.object({
  id: sessionId, identityId,
  agentId: z.string().min(1),
  browserAuthority: z.string().min(1),
  issuedAt: timestamp, expiresAt: timestamp,
  revokedAt: timestamp.optional(),
  lastSeenAt: timestamp,
}).strict()

/** Domain version one contains no access or refresh token. */
export const wecomAuthDomain = defineDomain({ name: 'company_wecom_official_auth', version: 1, tables: {
  identities: domainTable<WecomIdentityId, z.infer<typeof identity>>(identity),
  attempts: domainTable<WecomLoginAttemptId, z.infer<typeof attempt>>(attempt),
  sessions: domainTable<WecomSessionId, z.infer<typeof session>>(session),
} })

/** Persisted enterprise member and administrative enablement. */
export type WecomIdentityRecord = z.infer<typeof identity>
/** Persisted browser-bound, single-use state. */
export type WecomLoginAttemptRecord = z.infer<typeof attempt>
/** Persisted browser session and revocation. */
export type WecomSessionRecord = z.infer<typeof session>
