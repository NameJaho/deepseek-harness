/** Browser-safe enterprise member identities; app credentials never enter these projections. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RemoteAccessBinding } from '@deepseek-ai/dsh-api-remote-access/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Stable Host identity for one enterprise member. */
export type WecomIdentityId = Branded<'wecom-identity-id'>
/** Configured enterprise identifier. */
export type WecomCorpId = Branded<'wecom-corp-id'>
/** Stable member identifier returned by official WeCom APIs. */
export type WecomUserId = Branded<'wecom-user-id'>
/** Enterprise role reserved for future administrator policy differences. */
export type WecomUserRole = 'admin' | 'user'
/** Browser-bound, single-use login attempt. */
export type WecomLoginAttemptId = Branded<'wecom-login-attempt-id'>
/** Signed local browser session. */
export type WecomSessionId = Branded<'wecom-session-id'>

/** Credential-free enterprise browser principal. */
export interface WecomUserPrincipal {
  readonly kind: 'wecom-user'
  readonly identityId: WecomIdentityId
  readonly corpId: WecomCorpId
  readonly userId: WecomUserId
  readonly role: WecomUserRole
}

/** Authenticated company member supplied by OAuth or a trusted gateway. */
export type CompanyUserPrincipal = WecomUserPrincipal | GatewayUserPrincipal

/** Resource owner scope: `wecom:<corpId>:<userId>`, `gateway:<userId>`, or `local-owner`. */
export type CompanyOwnerScope = Branded<'company-owner-scope'>

/** Business-owned grants and Session ownership lookup contributed by another company plugin. */
export interface WecomResourceProvider {
  /** Additional command names allowed only in the member's default Workspace Sessions; omission grants none. */
  readonly defaultWorkspaceCommands?: readonly string[]
  /** Compute grants for one active member from current committed business records. */
  bindings(principal: CompanyUserPrincipal): readonly RemoteAccessBinding[]
  /** Resolve the owner of a tool-initiating Session; `undefined` delegates to another provider. */
  sessionOwner(sessionId: SessionId): CompanyOwnerScope | undefined
}

/** Public QR/OAuth parameters and unpredictable state. */
export interface WecomLoginConfig {
  readonly corpId: WecomCorpId
  readonly agentId: string
  readonly redirectUri: string
  readonly state: string
  readonly attemptId: WecomLoginAttemptId
  readonly expiresAt: number
}

/** Current browser identity without credentials. */
export interface WecomSessionView {
  readonly identityId: WecomIdentityId
  readonly corpId: WecomCorpId
  readonly userId: WecomUserId
  readonly role: WecomUserRole
  readonly displayName?: string
  /** Optional logout destination for identities managed by an upstream gateway. */
  readonly logoutUrl?: string
  readonly expiresAt: number
}

/** Successful login; redirect is taken exclusively from the saved attempt. */
export interface WecomLoginResult {
  readonly session: WecomSessionView
  readonly redirect: string
}

/** Stable sanitized failure identifiers. */
export type WecomAuthErrorCode =
  | 'wecom-auth/invalid-request'
  | 'wecom-auth/expired'
  | 'wecom-auth/forbidden'
  | 'wecom-auth/disabled'
  | 'wecom-auth/remote-failure'
  | 'wecom-auth/unavailable'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Authenticated member; no browser cookie or app access token. */
    'wecom-user': WecomUserPrincipal
    /** Identity asserted by a trusted upstream portal gateway. */
    'gateway-user': GatewayUserPrincipal
  }
}

/** Credential-free identity asserted by a trusted upstream portal gateway. */
export interface GatewayUserPrincipal {
  readonly kind: 'gateway-user'
  readonly identityId: WecomIdentityId
  readonly userId: WecomUserId
  readonly displayName: string
  readonly role: WecomUserRole
}
