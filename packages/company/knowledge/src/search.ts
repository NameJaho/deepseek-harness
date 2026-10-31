/** Bounded HTTP retrieval protocol; endpoint details and upstream bodies never enter client errors. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Config, KnowledgeSourceConfig } from './config.ts'
import type { CompanyKnowledgeSearchResult, KnowledgeChunkId, KnowledgeDocumentId } from './types.ts'

const responseSchema = z.object({
  results: z.array(z.object({
    chunk_id: z.string().min(1), document_id: z.string().min(1), doc_title: z.string(),
    breadcrumb: z.string(), content: z.string(), score: z.number().min(0).max(1), space_id: z.string().min(1),
  })),
  total_hits: z.number().int().nonnegative(),
})

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

function failed(message: string, reason: 'transport' | 'response', cause?: unknown): RemoteError<'company-knowledge/search-failed'> {
  return new RemoteError('company-knowledge/search-failed', message, { reason }, cause === undefined ? undefined : { cause })
}

/** Fetch approved-space evidence without accepting model-supplied connection settings.
 * @param source - deployment-owned endpoint and nonempty space allowlist.
 * @param query - validated natural-language question.
 * @param authorization - resolved request headers carrying the source credential; empty when none is configured.
 * @param config - bounded retrieval policy.
 * @param signal - request deadline and lifecycle cancellation.
 * @returns high-relevance, deduplicated source passages; no upstream endpoint fields.
 */
export async function searchKnowledge(source: KnowledgeSourceConfig, query: string,
  authorization: Readonly<Record<string, string>>, config: Config, signal: AbortSignal): Promise<CompanyKnowledgeSearchResult> {
  let response: Response
  try {
    response = await fetch(source.searchUrl, { method: 'POST', redirect: 'error', signal,
      headers: { accept: 'application/json', 'content-type': 'application/json', ...authorization },
      body: JSON.stringify({ query, space_ids: source.spaceIds, top_k: config.topK, mode: 'hybrid', rerank: true }) })
  } catch (error) {
    signal.throwIfAborted()
    throw failed('Knowledge search could not reach its service', 'transport', error)
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new RemoteError('company-knowledge/search-failed', 'Knowledge search service rejected the request',
      { reason: 'http', status: response.status })
  }
  let raw: unknown
  try { raw = JSON.parse(await responseText(response, config.maxResponseBytes)) }
  catch (error) {
    signal.throwIfAborted()
    throw failed('Knowledge search returned an unreadable response', 'response', error)
  }
  const parsed = responseSchema.safeParse(raw)
  if (!parsed.success || parsed.data.total_hits < parsed.data.results.length
    || parsed.data.results.length > config.topK
    || parsed.data.results.some(hit => !source.spaceIds.includes(hit.space_id))) {
    throw failed('Knowledge search returned invalid evidence', 'response')
  }
  const seen = new Set<string>()
  const hits = parsed.data.results.filter((hit) => {
    if (hit.score < config.minimumScore || hit.content.trim().length === 0 || seen.has(hit.content)) return false
    seen.add(hit.content)
    return true
  }).map(hit => ({ chunkId: brandString<KnowledgeChunkId>(hit.chunk_id),
    documentId: brandString<KnowledgeDocumentId>(hit.document_id), documentTitle: hit.doc_title,
    breadcrumb: hit.breadcrumb, content: hit.content, score: hit.score }))
  return { sourceId: source.id, hits, returned: parsed.data.results.length, totalHits: parsed.data.total_hits,
    belowThreshold: parsed.data.results.filter(hit => hit.score < config.minimumScore).length }
}
