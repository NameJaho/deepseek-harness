/** Plugin-owned implementation of the official WeCom popup message protocol. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

/** Browser authorization failures; provider payloads are never retained in errors. */
export type WecomAuthorizationErrorCode = 'WINDOW_BLOCKED' | 'CANCELLED' | 'AUTH_TIMEOUT' | 'INVALID_RESPONSE'

/** A credential-free failure handled by the controller's localized reporting. */
export class WecomAuthorizationError extends Error {
  /**
   * @param code - stable authorization failure identity.
   * @param options - original browser failure, when opening the popup throws.
   */
  constructor(readonly code: WecomAuthorizationErrorCode, options?: ErrorOptions) {
    super(`WeCom authorization: ${code}`, options)
    this.name = 'WecomAuthorizationError'
  }
}

type BotInfo = { botid: string; secret: string }
const AUTH_ORIGIN = 'https://work.weixin.qq.com'

/** Owns resources only during an authorization; construction has no browser effects. */
export class WecomAuthorizationPopup {
  private cancelPending: (() => void) | undefined

  /**
   * Open synchronously in a user gesture. Only this popup at the official origin may
   * authorize; the SDK protocol does not echo state in messages. Every terminal
   * outcome removes listeners and timers and closes the popup before settlement.
   * @param options - deployment source and the pending request's absolute expiry.
   * @returns transient credentials, or a credential-free typed failure; no credentials are cached.
   */
  open(options: { source: string; expiresAt: number }): Promise<BotInfo> {
    this.cancel()
    if (options.expiresAt <= Date.now()) return Promise.reject(new WecomAuthorizationError('AUTH_TIMEOUT'))
    const state = randomUUID()
    const url = new URL('/ai/qc/gen', AUTH_ORIGIN)
    url.search = new URLSearchParams({ source: options.source, state, timestamp: String(Date.now()) }).toString()
    return new Promise((resolve, reject) => {
      let popup: Window | null
      try {
        popup = window.open(url.href, `wecom-auth-${state}`, 'width=950,height=640,resizable=no,scrollbars=no')
      } catch (error) {
        reject(new WecomAuthorizationError('WINDOW_BLOCKED', { cause: error }))
        return
      }
      if (popup === null) { reject(new WecomAuthorizationError('WINDOW_BLOCKED')); return }
      const ownedPopup = popup
      let settled = false
      const finish = (result: BotInfo | WecomAuthorizationError): void => {
        if (settled) return
        settled = true
        window.removeEventListener('message', message)
        window.removeEventListener('pagehide', cancel)
        window.removeEventListener('beforeunload', cancel)
        clearInterval(polling)
        clearTimeout(timeout)
        this.cancelPending = undefined
        try { ownedPopup.close() } catch (_error) { /* The browser may already have destroyed the window. */ }
        if (result instanceof WecomAuthorizationError) reject(result)
        else resolve(result)
      }
      const cancel = (): void => { finish(new WecomAuthorizationError('CANCELLED')) }
      const message = (event: MessageEvent<unknown>): void => {
        if (event.origin !== AUTH_ORIGIN || event.source !== ownedPopup) return
        if (options.expiresAt <= Date.now()) { finish(new WecomAuthorizationError('AUTH_TIMEOUT')); return }
        const data = event.data
        if (typeof data !== 'object' || data === null || Array.isArray(data)
          || !('type' in data) || typeof data.type !== 'string') {
          finish(new WecomAuthorizationError('INVALID_RESPONSE'))
          return
        }
        switch (data.type) {
          case 'AUTH_SUCCESS': {
            const payload = 'payload' in data ? data.payload : undefined
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
              || !('botid' in payload) || typeof payload.botid !== 'string'
              || payload.botid.trim().length === 0 || payload.botid.length > 256
              || !('secret' in payload) || typeof payload.secret !== 'string'
              || payload.secret.length === 0 || payload.secret.length > 4096) {
              finish(new WecomAuthorizationError('INVALID_RESPONSE'))
              return
            }
            finish({ botid: payload.botid, secret: payload.secret })
            return
          }
          case 'AUTH_CANCEL':
          case 'WINDOW_CLOSE': cancel(); return
          case 'AUTH_ERROR': finish(new WecomAuthorizationError('INVALID_RESPONSE')); return
          default: return // QR_CODE_READY and unrelated messages do not settle authorization.
        }
      }
      // Match the official SDK's closed-window polling cadence.
      const polling = setInterval(() => { if (ownedPopup.closed) cancel() }, 500)
      const expire = (): void => {
        const remaining = options.expiresAt - Date.now()
        if (remaining <= 0) finish(new WecomAuthorizationError('AUTH_TIMEOUT'))
        else timeout = setTimeout(expire, Math.min(remaining, 2_147_483_647))
      }
      // Browser timers use signed 32-bit delays; longer request lifetimes rearm.
      let timeout = setTimeout(expire, Math.min(options.expiresAt - Date.now(), 2_147_483_647))
      this.cancelPending = cancel
      window.addEventListener('message', message)
      window.addEventListener('pagehide', cancel)
      window.addEventListener('beforeunload', cancel)
    })
  }

  /** Cancel the active operation and settle its promise; idle cancellation has no effects. */
  cancel(): void { this.cancelPending?.() }
}
