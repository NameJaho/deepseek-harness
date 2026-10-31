/** Logical, secret-free external agent discovery and execution facts. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Deployment-owned logical external agent identity, unrelated to a platform URL. */
export type ExternalAgentId = Branded<'ExternalAgentId'>

/** Safe classifications; HTTP error bodies and transport messages are never displayed. */
export type ExternalAgentFailureCode =
  | 'configuration' | 'credential-unavailable' | 'invalid-input' | 'input-limit'
  | 'http-status' | 'response-size' | 'response-encoding' | 'response-format'
  | 'transport' | 'timeout' | 'aborted' | 'disposed' | 'capacity'
  | 'continuation-disabled' | 'continuation-owner' | 'continuation-unavailable' | 'continuation-busy'

/** Handling-relevant failure facts. Unknown effects forbid automatic repetition. */
export interface ExternalAgentFailure {
  readonly code: ExternalAgentFailureCode
  readonly effect: 'not-sent' | 'rejected' | 'unknown'
  readonly httpStatus?: number
}

/** Browser-safe deployment descriptor; credentials and endpoints have no fields here. */
export interface ExternalAgentDescriptor {
  readonly id: ExternalAgentId
  readonly name: string
  readonly version: string
  readonly environment: string
  readonly platform: 'dify'
  readonly providerName: string
  readonly continuationAllowed: boolean
  readonly status: 'configured' | 'disposed'
}

/** Retained execution identity; actual answers use the standard logged subagent result. */
export interface ExternalAgentRunDescriptor {
  readonly childId: SessionId
  readonly parentSessionId: SessionId
  readonly agent: ExternalAgentDescriptor
  readonly continuationOf?: SessionId
  readonly input: { readonly sha256: string; readonly bytes: number }
  readonly startedAt: number
  readonly state:
    | { readonly status: 'running' }
    | { readonly status: 'completed'; readonly endedAt: number; readonly output: { readonly sha256: string; readonly bytes: number } }
    | { readonly status: 'failed'; readonly endedAt: number; readonly failure: ExternalAgentFailure }
}
