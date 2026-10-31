/** Host-only direct retrieve endpoints, approved spaces and response bounds. */
import z from '@deepseek-ai/schemastery'

/** Deployment-owned knowledge source. Models and browsers cannot submit or read these endpoint or space fields. */
export interface KnowledgeSourceConfig {
  /** Logical identifier selected by Agent authors. */
  id: string
  /** Display name in capability lists. */
  name: string
  /** Public-safe description of this source. */
  description: string
  /** HTTP search endpoint used only by the Host. */
  searchUrl: string
  /** Exact nonempty upstream space allowlist injected into every request. */
  spaceIds: string[]
}

/** Retrieval policy and deployment source list. */
export interface Config {
  /** Configured knowledge sources; an empty list leaves the page in its unconfigured state. */
  sources: KnowledgeSourceConfig[]
  /** Largest requested hit count; upstream accepts at most 50. */
  topK: number
  /** Minimum rerank score accepted as evidence. Every request enables rerank. */
  minimumScore: number
  /** Deadline for one read-only upstream request. The direct service may verify and supplement for up to 30 seconds. */
  timeoutMs: number
  /** Maximum characters in one natural-language query. */
  maxQueryChars: number
  /** Maximum complete upstream response bytes. */
  maxResponseBytes: number
}

/** Validated Host settings; omitted policy fields take their defaults. */
export const Config: z<Partial<Config>, Config> = z.object({
  sources: z.array(z.object({
    id: z.string().pattern(/^[a-z0-9][a-z0-9-]{0,63}$/).required(),
    name: z.string().min(1).required(),
    description: z.string().default(''),
    searchUrl: z.string().min(1).required(),
    spaceIds: z.array(z.string().min(1)).min(1).required(),
  })).default([]),
  topK: z.natural().min(1).max(50).default(5),
  minimumScore: z.number().min(0).max(1).default(0.5),
  timeoutMs: z.natural().min(1).default(60000),
  maxQueryChars: z.natural().min(1).default(16000),
  maxResponseBytes: z.natural().min(1).default(8388608),
})
