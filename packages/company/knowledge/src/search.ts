/** Bounded HTTP retrieval for the direct `knowledge_search_api/retrieve` protocol. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Config, KnowledgeSourceConfig } from './config.ts'
import type {
  CompanyKnowledgeRetrieveDetails,
  CompanyKnowledgeRetrieveOptions,
  CompanyKnowledgeDetailedSearchResult,
  CompanyKnowledgeSearchResult,
  KnowledgeChunkId,
  KnowledgeDocumentId,
} from './types.ts'

const evidenceSchema = z.record(z.string(), z.unknown())
const retrieveSchema = z.object({
  query: z.string().optional(), rewritten: z.string().optional(), plan: evidenceSchema.optional(), signals: evidenceSchema.optional(),
  same_topic: z.boolean().optional(), locked_method_id: z.string().optional(), verified: z.boolean().optional(),
  sufficient: z.boolean().optional(), missing: z.string().optional(), conflicts: z.array(evidenceSchema).optional(),
  reply_strategy: z.union([evidenceSchema, z.null()]).optional(),
  results: z.looseObject({
    chunks: z.array(evidenceSchema).default([]), images: z.array(evidenceSchema).default([]),
    im: z.array(evidenceSchema).default([]), graph: z.array(evidenceSchema).default([]),
  }),
  references: z.array(evidenceSchema).optional(), activity: evidenceSchema.optional(),
}).loose()

type JsonRecord = Record<string, unknown>

function stringField(value: JsonRecord, names: readonly string[]): string | undefined {
  for (const name of names) {
    const candidate = value[name]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

function numberField(value: JsonRecord, names: readonly string[]): number | undefined {
  for (const name of names) {
    const candidate = value[name]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

function failed(message: string, reason: 'transport' | 'http' | 'response', cause?: unknown, status?: number): RemoteError<'company-knowledge/search-failed'> {
  return new RemoteError('company-knowledge/search-failed', message, { reason, ...(status === undefined ? {} : { status }) },
    cause === undefined ? undefined : { cause })
}

/** Read an entire response under a strict byte bound before accepting any evidence. */
async function responseText(response: Response, maximum: number): Promise<string> {
  if (response.body === null) throw new Error('Knowledge response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let text = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > maximum) {
        await reader.cancel('Knowledge response exceeds its byte limit')
        throw new Error('Knowledge response exceeds its byte limit')
      }
      text += decoder.decode(next.value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

function requestBody(source: KnowledgeSourceConfig, query: string, options: CompanyKnowledgeRetrieveOptions | undefined): JsonRecord {
  const messages = options?.messages ?? [{ role: 'user' as const, content: query }]
  return {
    ...(messages.length === 0 && options?.image !== undefined ? {} : { messages }),
    ...(options?.image === undefined ? {} : { image: options.image }),
    space_ids: source.spaceIds,
    ...(options?.emotion === undefined ? {} : { emotion: options.emotion }),
    ...(options?.prevMethodId === undefined ? {} : { prev_method_id: options.prevMethodId }),
    ...(options?.verify === undefined ? {} : { verify: options.verify }),
    ...(options?.kbIds === undefined ? {} : { kb_ids: options.kbIds }),
    ...(options?.sources === undefined ? {} : { sources: options.sources }),
    ...(options?.topK === undefined ? {} : { top_k: options.topK }),
    ...(options?.filterDocType === undefined ? {} : { filter_doc_type: options.filterDocType }),
    ...(options?.excludeNeedsReview === undefined ? {} : { exclude_needs_review: options.excludeNeedsReview }),
  }
}

function detailsOf(value: z.infer<typeof retrieveSchema>): CompanyKnowledgeRetrieveDetails {
  return {
    ...(value.query === undefined ? {} : { query: value.query }), ...(value.rewritten === undefined ? {} : { rewritten: value.rewritten }),
    ...(value.plan === undefined ? {} : { plan: value.plan }), ...(value.signals === undefined ? {} : { signals: value.signals }),
    ...(value.same_topic === undefined ? {} : { sameTopic: value.same_topic }),
    ...(value.locked_method_id === undefined ? {} : { lockedMethodId: value.locked_method_id }),
    ...(value.verified === undefined ? {} : { verified: value.verified }),
    ...(value.sufficient === undefined ? {} : { sufficient: value.sufficient }),
    ...(value.missing === undefined ? {} : { missing: value.missing }),
    ...(value.conflicts === undefined ? {} : { conflicts: value.conflicts }),
    ...(value.reply_strategy === undefined ? {} : { replyStrategy: value.reply_strategy }),
    results: {
      chunks: value.results.chunks,
      images: value.results.images,
      im: value.results.im,
      graph: value.results.graph,
    },
    ...(value.references === undefined ? {} : { references: value.references }),
    ...(value.activity === undefined ? {} : { activity: value.activity }),
  }
}

function chunkHit(chunk: JsonRecord, index: number): CompanyKnowledgeSearchResult['hits'][number] {
  const candidate = chunk.answer_focus ?? chunk.content
  const content = typeof candidate === 'string' ? candidate : undefined
  if (content === undefined) throw new Error('Knowledge chunk has no content')
  return {
    chunkId: brandString<KnowledgeChunkId>(stringField(chunk, ['chunk_id', 'chunkId', 'id']) ?? `knowledge-chunk-${String(index)}`),
    documentId: brandString<KnowledgeDocumentId>(stringField(chunk, ['document_id', 'documentId', 'doc_id']) ?? `knowledge-document-${String(index)}`),
    documentTitle: stringField(chunk, ['doc_title', 'document_title', 'title']) ?? 'Knowledge result',
    breadcrumb: stringField(chunk, ['breadcrumb', 'section', 'path']) ?? '', content,
    score: numberField(chunk, ['score', 'score_rerank', 'rerank_score', 'relevance_score']) ?? 1,
  }
}

function chunkCount(details: CompanyKnowledgeRetrieveDetails, fallback: number): number {
  const signals = details.signals?.per_source
  if (typeof signals !== 'object' || signals === null || Array.isArray(signals)) return fallback
  const chunks = (signals as JsonRecord).chunks
  if (typeof chunks !== 'object' || chunks === null || Array.isArray(chunks)) return fallback
  const hits = (chunks as JsonRecord).hits
  return typeof hits === 'number' && Number.isInteger(hits) && hits >= 0 ? hits : fallback
}

/** Fetch approved-space evidence without accepting model-supplied connection settings.
 * @param source - deployment-owned direct retrieve endpoint and space allowlist.
 * @param query - current natural-language question.
 * @param options - conversation history and direct retrieve controls.
 * @param config - bounded retrieval policy.
 * @param signal - request deadline and lifecycle cancellation.
 * @returns validated evidence and the direct service's method/sufficiency signals.
 */
export async function searchKnowledge(
  source: KnowledgeSourceConfig,
  query: string,
  options: CompanyKnowledgeRetrieveOptions | undefined,
  config: Config,
  signal: AbortSignal,
): Promise<CompanyKnowledgeDetailedSearchResult> {
  let response: Response
  try {
    response = await fetch(source.searchUrl, { method: 'POST', redirect: 'error', signal,
      headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(requestBody(source, query, options)) })
  } catch (error) {
    signal.throwIfAborted()
    throw failed('Knowledge search could not reach its service', 'transport', error)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw failed('Knowledge search service rejected the request', 'http', undefined, response.status)
  }
  let raw: unknown
  try { raw = JSON.parse(await responseText(response, config.maxResponseBytes)) }
  catch (error) {
    signal.throwIfAborted()
    throw failed('Knowledge search returned an unreadable response', 'response', error)
  }
  const parsed = retrieveSchema.safeParse(raw)
  if (!parsed.success) throw failed('Knowledge search returned an invalid retrieve response', 'response', parsed.error)
  const retrieve = detailsOf(parsed.data)
  const chunks = parsed.data.results.chunks
  if (chunks.some((chunk) => {
    const spaceId = stringField(chunk, ['space_id'])
    return spaceId === undefined || !source.spaceIds.includes(spaceId)
  })) throw failed('Knowledge search returned evidence outside the approved spaces', 'response')
  if (chunks.some((chunk) => {
    const score = numberField(chunk, ['score', 'score_rerank', 'rerank_score', 'relevance_score'])
    return score !== undefined && (score < 0 || score > 1)
  })) throw failed('Knowledge search returned an invalid relevance score', 'response')
  const seen = new Set<string>()
  const hits = chunks.map(chunkHit).filter((hit) => {
    if (hit.score < config.minimumScore || hit.content.trim().length === 0 || seen.has(hit.content)) return false
    seen.add(hit.content)
    return true
  }).slice(0, config.topK)
  return {
    sourceId: source.id, returned: chunks.length, totalHits: chunkCount(retrieve, chunks.length),
    belowThreshold: chunks.filter(chunk => (numberField(chunk, ['score', 'score_rerank', 'rerank_score', 'relevance_score']) ?? 1) < config.minimumScore).length,
    hits, retrieve,
  }
}
