/** Safe structured failures for external agent operations. */
import type { ExternalAgentFailure, ExternalAgentFailureCode } from './types.ts'

/** Expected provider failure; its cause is private and its display text contains only safe facts. */
export class ExternalAgentError extends Error {
  /** @param failure - safe classification and effect certainty.
   * @param cause - private underlying error; omitted for provider-owned rejections.
   */
  constructor(readonly failure: ExternalAgentFailure, cause?: unknown) {
    super(`External agent call failed (${failure.code}; effect: ${failure.effect}). ${failure.effect === 'unknown'
      ? 'The remote outcome is unknown; check the platform before starting a new call.'
      : 'Check the agent configuration or input before starting a new call.'}`, { cause })
    this.name = 'ExternalAgentError'
  }
}

/** Construct an expected failure without copying a remote message.
 * @param code - stable classification.
 * @param effect - certainty about the remote call.
 * @param cause - private cause, if available.
 * @returns the structured error.
 */
export function failure(code: ExternalAgentFailureCode, effect: ExternalAgentFailure['effect'], cause?: unknown): ExternalAgentError {
  return new ExternalAgentError({ code, effect }, cause)
}

/** Await an operation without letting late fulfillment resume cancelled work.
 * The underlying credential service owns its own I/O; HTTP uses this signal directly.
 * @param promise - operation whose rejection remains observed after cancellation.
 * @param signal - the operation lifecycle.
 * @returns the value, or rejects with the lifecycle's safe failure.
 */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abort = Promise.withResolvers<never>()
  const onAbort = (): void => { abort.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  try {
    return await Promise.race([promise, abort.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
