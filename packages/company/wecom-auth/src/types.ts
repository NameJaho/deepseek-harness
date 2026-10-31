/** Browser-safe enterprise member identities; app credentials never enter these projections. */
import type { Branded } from '@deepseek-ai/dsh-brand'

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
