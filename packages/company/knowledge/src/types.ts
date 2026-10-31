/** Browser-safe knowledge source metadata, approved bindings and retrieved evidence. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Identity of one knowledge document returned by the search service. */
export type KnowledgeDocumentId = Branded<'knowledge-document-id'>
/** Identity of one retrieved knowledge passage. */
export type KnowledgeChunkId = Branded<'knowledge-chunk-id'>

/** Configured logical source; private URLs and upstream space identities are excluded. */
export interface CompanyKnowledgeSource {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** One role/content pair sent to the direct retrieve endpoint. */
export interface CompanyKnowledgeMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** Optional direct-retrieve controls supplied by a trusted Host caller. */
export interface CompanyKnowledgeRetrieveOptions {
  readonly messages?: readonly CompanyKnowledgeMessage[]
  readonly emotion?: string
  readonly prevMethodId?: string
  readonly verify?: boolean
  readonly image?: string
  readonly kbIds?: readonly string[]
  readonly sources?: readonly ('chunks' | 'images' | 'im' | 'graph')[]
  readonly topK?: number
  readonly filterDocType?: string
  readonly excludeNeedsReview?: boolean
}

/** JSON object returned by one retrieve source; fields remain available to the model-facing tool. */
export type CompanyKnowledgeEvidence = Readonly<Record<string, unknown>>

/** Direct retrieve response grouped by knowledge source. */
export interface CompanyKnowledgeRetrieveDetails {
  readonly query?: string
  readonly rewritten?: string
  readonly plan?: CompanyKnowledgeEvidence
  readonly signals?: CompanyKnowledgeEvidence
  readonly sameTopic?: boolean
  readonly lockedMethodId?: string
  readonly verified?: boolean
  readonly sufficient?: boolean
  readonly missing?: string
  readonly conflicts?: readonly CompanyKnowledgeEvidence[]
  readonly replyStrategy?: CompanyKnowledgeEvidence | null
  readonly results: Readonly<Record<string, readonly CompanyKnowledgeEvidence[]>>
  readonly references?: readonly CompanyKnowledgeEvidence[]
  readonly activity?: CompanyKnowledgeEvidence
}

/** Owner management catalog: configured sources and the accepted query length. */
export interface CompanyKnowledgeCatalog {
  readonly sources: readonly CompanyKnowledgeSource[]
  /** Longest trimmed query, in UTF-16 code units, that a search accepts. */
  readonly maxQueryChars: number
}

/** Approved source identity and permission fingerprint retained with one Agent release. */
export interface CompanyKnowledgeBinding {
  readonly id: string
  /** SHA-256 hex digest of the source's sorted, deduplicated space allowlist. */
  readonly fingerprint: string
}

/** Retrieved evidence with the complete source content and a comparable rerank score. */
export interface CompanyKnowledgeHit {
  readonly chunkId: KnowledgeChunkId
  readonly documentId: KnowledgeDocumentId
  readonly documentTitle: string
  readonly breadcrumb: string
  readonly content: string
  /** Rerank relevance from 0 to 1. */
  readonly score: number
}

/** Explicit source selection and natural-language query. */
export interface CompanyKnowledgeSearchRequest {
  readonly sourceId: string
  readonly query: string
  readonly options?: CompanyKnowledgeRetrieveOptions
}

/** Approved retrieval result; an empty result does not establish that the configured upstream space exists. */
export interface CompanyKnowledgeSearchResult {
  readonly sourceId: string
  /** Deduplicated passages at or above the minimum score, in upstream order. */
  readonly hits: readonly CompanyKnowledgeHit[]
  /** Passages in the validated upstream response. */
  readonly returned: number
  /** Upstream `total_hits`, which can exceed `returned`. */
  readonly totalHits: number
  /** Returned passages removed by the minimum score. */
  readonly belowThreshold: number
}

/** Host-only result retained for Cloud Agent execution and model-facing evidence. */
export interface CompanyKnowledgeDetailedSearchResult extends CompanyKnowledgeSearchResult {
  /** Validated fields from the direct retrieve response, including method and sufficiency signals. */
  readonly retrieve: CompanyKnowledgeRetrieveDetails
}

/** Failure classification of one upstream retrieval. */
export type CompanyKnowledgeFailureReason = 'timeout' | 'transport' | 'http' | 'response'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'company-knowledge/owner-required': Record<string, never>
    'company-knowledge/invalid-input': { readonly field: string }
    'company-knowledge/not-found': { readonly sourceId: string }
    'company-knowledge/binding-changed': { readonly sourceId: string }
    'company-knowledge/unavailable': Record<string, never>
    'company-knowledge/search-failed': { readonly status?: number; readonly reason: CompanyKnowledgeFailureReason }
  }
}
