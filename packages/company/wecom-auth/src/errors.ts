/** Sanitized authentication failures; upstream secrets never enter diagnostics. */
import type { WecomAuthErrorCode } from './types.ts'

/** Expected request, authentication-center or storage failure. */
export class WecomAuthError extends Error {
  /**
   * @param code - stable public failure code.
   * @param status - HTTP status returned without the upstream response body.
   */
  constructor(readonly code: WecomAuthErrorCode, readonly status: number) {
    super(code)
    this.name = 'WecomAuthError'
  }
}
