/** Bounded UTF-8 reads of attachments already recorded in the invoking conversation. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { AttachmentStore, FileAttachmentRef, AttachmentIdType } from '@deepseek-ai/dsh-attachment'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import type { Config } from './config.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { companyConversationFiles: FileAttachmentRef[] }
}

/** Uploaded references retained independently of the compacted model surface. */
export const conversationFilesProjection = {
  key: 'companyConversationFiles', stateVersion: 1,
  stateSchema: z.array(z.object({ attachmentId: z.string().min(1).transform(value => brandString<AttachmentIdType>(value)),
    name: z.string(), bytes: z.number().int().nonnegative() })),
  init: (): FileAttachmentRef[] => [],
  apply: (state, event) => {
    if (event.type !== 'user/message') return state
    const added = event.data.content.flatMap(block => block.type === 'file' ? [{ ...block.attachment }] : [])
    if (added.length === 0) return state
    const refs = new Map([...state, ...added].map(ref => [`${ref.attachmentId}:${ref.name}`, ref]))
    return [...refs.values()]
  },
} satisfies ProjectionDefinition<'companyConversationFiles', FileAttachmentRef[]>

/** One explicit text page request over a previously uploaded attachment. */
export interface ConversationFileReadRequest {
  readonly attachmentId: AttachmentIdType
  readonly offset?: number
  readonly limit?: number
}

/** Verified text page; offsets count Unicode code points and never split a surrogate pair. */
export interface ConversationFilePage {
  readonly attachment: FileAttachmentRef
  readonly offset: number
  readonly text: string
  readonly nextOffset: number | null
  readonly totalChars: number
}

/** Find uploaded files in durable user messages, including history replaced by compaction.
 * @param projection - owning projection with uploaded-reference state.
 * @param session - invoking conversation and its inherited durable history.
 * @returns detached file references deduplicated by content identity and display name.
 */
export function conversationFiles(projection: ProjectionHandle<FileAttachmentRef[]>, session: Session): FileAttachmentRef[] {
  return projection.stateOf(session).map(ref => ({ ...ref }))
}

/** Verify a complete stored file while retaining only the requested bounded text page.
 * @param store - mounted attachment provider, never an arbitrary filesystem.
 * @param ref - reference selected from the invoking conversation.
 * @param request - untrusted page fields checked before reading.
 * @param config - deployment-owned byte and page bounds.
 * @param signal - tool cancellation.
 * @returns the UTF-8 page after the provider has verified every stored byte.
 */
export async function readConversationFile(store: AttachmentStore, ref: FileAttachmentRef,
  request: ConversationFileReadRequest, config: Config, signal: AbortSignal): Promise<ConversationFilePage> {
  const offset = request.offset ?? 0
  const limit = request.limit ?? config.filePageChars
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > config.filePageChars) {
    throw new RemoteError('cloud-agent/invalid-input', 'Check the attachment text offset and page limit', { reason: 'file-page' })
  }
  if (ref.bytes > config.fileReadMaxBytes) {
    throw new RemoteError('cloud-agent/invalid-input', 'This attachment exceeds the configured text-read byte limit', { reason: 'file-too-large' })
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let totalChars = 0
  let text = ''
  const append = (part: string): void => {
    if (part.includes('\0')) throw new Error('Binary file is not a text attachment')
    const points = Array.from(part)
    const begin = Math.max(0, offset - totalChars)
    const end = Math.min(points.length, offset + limit - totalChars)
    if (end > begin) text += points.slice(begin, end).join('')
    totalChars += points.length
  }
  try {
    for await (const bytes of store.readFileStream(ref, signal)) append(decoder.decode(bytes, { stream: true }))
    append(decoder.decode())
  } catch (error) {
    signal.throwIfAborted()
    throw new RemoteError('cloud-agent/invalid-input', 'The attachment could not be verified as UTF-8 text',
      { reason: 'file-unreadable' }, { cause: error })
  }
  return { attachment: { ...ref }, offset, text, nextOffset: offset + Array.from(text).length < totalChars
    ? offset + Array.from(text).length : null, totalChars }
}
