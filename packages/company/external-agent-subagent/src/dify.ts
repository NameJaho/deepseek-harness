/** Documented Dify blocking chat-messages adapter, without project execution or tool delegation. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ExternalAgentError, failure } from './error.ts'

type ConversationId = Branded<'ExternalAgentConversationId'>
type MessageId = Branded<'ExternalAgentMessageId'>

/** Private transport request; only query and explicitly configured inputs are transmitted. */
export interface ExternalAgentCall {
  readonly query: string
  readonly user: string
  readonly conversationId?: ConversationId
  readonly signal: AbortSignal
  readonly credential: string
}

/** Validated complete answer; platform identifiers remain Host-only. */
export interface ExternalAgentAnswer {
  readonly answer: string
  readonly conversationId: ConversationId
  readonly messageId: MessageId
}

/** Replaceable platform adapter behind the standard subagent provider. */
export interface ExternalAgentAdapter {
  /** @param call - resolved private request.
   * @param sent - synchronous notification immediately before dispatch.
   * @returns only a fully validated blocking answer; partial responses reject.
   */
  call(call: ExternalAgentCall, sent: () => void): Promise<ExternalAgentAnswer>
}

/** Explicit deployment configuration; no endpoint or inputs are returned as descriptors. */
export interface DifySpec {
  readonly endpoint: string
  readonly inputs: Readonly<Record<string, JsonValue>>
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
}

/** Reject JSON strings that cannot be represented losslessly in UTF-8.
 * @param text - query or decoded response field.
 * @returns whether the string contains only valid Unicode scalar values.
 */
export function validUnicode(text: string): boolean {
  return text.isWellFormed() && !text.includes('\u0000')
}

/** Dify Chatbot/Chatflow adapter; Agent apps that require streaming fail as HTTP errors. */
export class DifyAdapter implements ExternalAgentAdapter {
  /** @param spec - validated private endpoint, inputs and complete request/response limits. */
  constructor(private readonly spec: DifySpec) {}

  /** @param call - private operation values.
   * @param sent - mark the call's effects unknown immediately before fetch.
   * @returns a complete answer with validated identifiers.
   */
  async call(call: ExternalAgentCall, sent: () => void): Promise<ExternalAgentAnswer> {
    const body = JSON.stringify({
      inputs: this.spec.inputs,
      query: call.query,
      response_mode: 'blocking',
      user: call.user,
      ...(call.conversationId === undefined ? {} : { conversation_id: call.conversationId }),
    })
    if (Buffer.byteLength(body, 'utf8') > this.spec.maxInputBytes) throw failure('input-limit', 'not-sent')
    call.signal.throwIfAborted()
    sent()
    const response = await fetch(this.spec.endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${call.credential}` },
      body,
      signal: call.signal,
    })
    try {
      if (response.status !== 200) {
        throw new ExternalAgentError({
          code: 'http-status',
          effect: response.status >= 400 && response.status < 500 && response.status !== 408 ? 'rejected' : 'unknown',
          httpStatus: response.status,
        })
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
        throw failure('response-encoding', 'unknown')
      }
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > this.spec.maxOutputBytes)) {
        throw failure('response-size', 'unknown')
      }
      if (response.body === null) throw failure('response-format', 'unknown')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const part = await reader.read()
          if (part.done) break
          size += part.value.byteLength
          if (size > this.spec.maxOutputBytes) throw failure('response-size', 'unknown')
          chunks.push(part.value)
        }
      } finally {
        // Abort terminates a still-readable response; releaseLock alone would leave the HTTP body alive.
        if (size > this.spec.maxOutputBytes || call.signal.aborted) await reader.cancel()
        reader.releaseLock()
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
      } catch (error: unknown) {
        throw failure('response-encoding', 'unknown', error)
      }
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch (error: unknown) {
        throw failure('response-format', 'unknown', error)
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw failure('response-format', 'unknown')
      const fields = value as Record<string, unknown>
      if (fields.event !== 'message' || (fields.mode !== 'chat' && fields.mode !== 'advanced-chat')
        || typeof fields.answer !== 'string' || fields.answer.trim().length === 0 || !validUnicode(fields.answer)
        || typeof fields.conversation_id !== 'string' || fields.conversation_id.trim().length === 0 || !validUnicode(fields.conversation_id)
        || typeof fields.message_id !== 'string' || fields.message_id.trim().length === 0 || !validUnicode(fields.message_id)) {
        throw failure('response-format', 'unknown')
      }
      if (call.conversationId !== undefined && fields.conversation_id !== call.conversationId) throw failure('response-format', 'unknown')
      // Additional documented metadata is ignored, never guessed or forwarded.
      return {
        answer: fields.answer,
        conversationId: brandString<ConversationId>(fields.conversation_id),
        messageId: brandString<MessageId>(fields.message_id),
      }
    } finally {
      if (response.body !== null && !response.body.locked) await response.body.cancel()
    }
  }
}
