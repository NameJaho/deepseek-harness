// @vitest-environment jsdom
/** Official popup protocol, sender validation, and operation-owned cleanup. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { WecomAuthorizationError, WecomAuthorizationPopup } from '../src/client/authorization.ts'

vi.mock('@wecom/wecom-aibot-sdk', () => { throw new Error('The singleton SDK must not be runtime imported') })

const ORIGIN = 'https://work.weixin.qq.com'
const OPTIONS = { source: 'deployment & source', expiresAt: 11_000 }
const BOT = { botid: 'bot-id', secret: 'transient-secret' }

function popupWindow() {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const popup = frame.contentWindow!
  Object.defineProperty(popup, 'closed', { configurable: true, value: false })
  const close = vi.spyOn(popup, 'close').mockImplementation(() => {})
  return { popup, close }
}

function send(popup: Window | null, data: unknown, origin = ORIGIN): void {
  window.dispatchEvent(new MessageEvent('message', { origin, source: popup, data }))
}

let adapter: WecomAuthorizationPopup
let popup: Window
let closePopup: MockInstance<() => void>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  adapter = new WecomAuthorizationPopup()
  const owned = popupWindow()
  popup = owned.popup
  closePopup = owned.close
  vi.spyOn(window, 'open').mockReturnValue(popup)
})

afterEach(() => {
  adapter.cancel()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function expectClean(): void {
  expect(closePopup).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
}

describe('WecomAuthorizationPopup', () => {
  it('has no constructor or idle cancellation browser effects', () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const idle = new WecomAuthorizationPopup()
    idle.cancel()
    expect(listen).not.toHaveBeenCalled()
    expect(window.open).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('opens synchronously at the official URL and accepts success without an echoed state', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const unlisten = vi.spyOn(window, 'removeEventListener')
    const log = vi.spyOn(console, 'log')
    const debug = vi.spyOn(console, 'debug')
    const error = vi.spyOn(console, 'error')
    const pending = adapter.open(OPTIONS)
    expect(window.open).toHaveBeenCalledOnce()
    const [address, name] = vi.mocked(window.open).mock.calls[0]!
    const url = new URL(String(address))
    expect(url.origin).toBe(ORIGIN)
    expect(url.pathname).toBe('/ai/qc/gen')
    expect(url.searchParams.get('source')).toBe(OPTIONS.source)
    expect(url.searchParams.get('timestamp')).toBe('1000')
    expect(url.searchParams.get('state')).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/)
    expect(name).toBe(`wecom-auth-${url.searchParams.get('state')}`)
    send(popup, { type: 'AUTH_SUCCESS', payload: { ...BOT, extra: 'discarded' }, timestamp: 1_000 })
    await expect(pending).resolves.toEqual(BOT)
    for (const type of ['message', 'pagehide', 'beforeunload']) {
      const listener = listen.mock.calls.find(([event]) => event === type)![1]
      expect(unlisten).toHaveBeenCalledWith(type, listener)
    }
    expectClean()
    expect(log).not.toHaveBeenCalled()
    expect(debug).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    adapter.cancel()
    expect(closePopup).toHaveBeenCalledOnce()
  })

  it('ignores spoofed origins and every source except the exact popup', async () => {
    const pending = adapter.open(OPTIONS)
    const settled = vi.fn()
    void pending.then(settled, settled)
    send(popup, { type: 'AUTH_SUCCESS', payload: BOT }, 'https://work.weixin.qq.com.evil.test')
    send(popup, { type: 'AUTH_CANCEL' }, 'https://evil.test')
    send(window, { type: 'AUTH_SUCCESS', payload: BOT })
    send(popupWindow().popup, { type: 'AUTH_SUCCESS', payload: BOT })
    send(null, { type: 'AUTH_SUCCESS', payload: BOT })
    send(popup, { type: 'QR_CODE_READY', payload: {} })
    send(popup, { type: 'UNRELATED' })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    expect(closePopup).not.toHaveBeenCalled()
    send(popup, { type: 'AUTH_SUCCESS', payload: BOT })
    await expect(pending).resolves.toEqual(BOT)
    expectClean()
  })

  it('uses a unique window name on replacement and refuses the old popup sender', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    const first = adapter.open(OPTIONS)
    const staleCancel = listen.mock.calls.find(([type]) => type === 'pagehide')![1]
    const firstFailure = expect(first).rejects.toMatchObject({ code: 'CANCELLED' })
    const { popup: replacement, close: closeReplacement } = popupWindow()
    vi.mocked(window.open).mockReturnValueOnce(replacement)
    const second = adapter.open(OPTIONS)
    const settled = vi.fn()
    void second.then(settled, settled)
    await firstFailure
    const names = vi.mocked(window.open).mock.calls.map(([, name]) => name)
    expect(names[0]).not.toBe(names[1])
    if (typeof staleCancel !== 'function') throw new Error('Missing operation cancellation callback')
    staleCancel(new Event('pagehide'))
    send(popup, { type: 'AUTH_SUCCESS', payload: BOT })
    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()
    send(replacement, { type: 'AUTH_SUCCESS', payload: BOT })
    await expect(second).resolves.toEqual(BOT)
    expectClean()
    expect(closeReplacement).toHaveBeenCalledOnce()
  })

  it('rejects a blocked popup without acquiring listeners or timers', async () => {
    const listen = vi.spyOn(window, 'addEventListener')
    vi.mocked(window.open).mockReturnValueOnce(null)
    const pending = adapter.open(OPTIONS)
    await expect(pending).rejects.toBeInstanceOf(WecomAuthorizationError)
    await expect(pending).rejects.toMatchObject({ code: 'WINDOW_BLOCKED' })
    expect(listen).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(closePopup).not.toHaveBeenCalled()
  })

  it('preserves a browser opening failure as a typed blocked error', async () => {
    const cause = new Error('browser denied opening')
    vi.mocked(window.open).mockImplementationOnce(() => { throw cause })
    await expect(adapter.open(OPTIONS)).rejects.toMatchObject({ code: 'WINDOW_BLOCKED', cause })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles explicit cancellation and removes the operation resources', async () => {
    const pending = adapter.open(OPTIONS)
    adapter.cancel()
    adapter.cancel()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expectClean()
  })

  it.each(['pagehide', 'beforeunload'])('settles cancellation on %s', async (type) => {
    const pending = adapter.open(OPTIONS)
    window.dispatchEvent(new Event(type))
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expectClean()
  })

  it.each(['AUTH_CANCEL', 'WINDOW_CLOSE'])('settles the official %s message', async (type) => {
    const pending = adapter.open(OPTIONS)
    send(popup, { type, timestamp: 1_000 })
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expectClean()
  })

  it('settles cancellation when the user closes the popup without a message', async () => {
    const pending = adapter.open(OPTIONS)
    const failure = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    Object.defineProperty(popup, 'closed', { configurable: true, value: true })
    await vi.advanceTimersByTimeAsync(500)
    await failure
    expectClean()
  })

  it('expires at the request deadline rather than granting a new full lifetime', async () => {
    const pending = adapter.open({ ...OPTIONS, expiresAt: 1_777 })
    const settled = vi.fn()
    void pending.then(settled, settled)
    const failure = expect(pending).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(776)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failure
    expectClean()
  })

  it('refuses expired requests without opening a window', async () => {
    await expect(adapter.open({ ...OPTIONS, expiresAt: 1_000 })).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' })
    expect(window.open).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses a late success even if the expiry timer has not run', async () => {
    const pending = adapter.open(OPTIONS)
    vi.setSystemTime(OPTIONS.expiresAt)
    send(popup, { type: 'AUTH_SUCCESS', payload: BOT })
    await expect(pending).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' })
    expectClean()
  })

  it('rearms deadlines exceeding the browser timer limit', async () => {
    const poll = vi.spyOn(globalThis, 'setInterval')
    const timer = vi.spyOn(globalThis, 'setTimeout')
    const pending = adapter.open({ ...OPTIONS, expiresAt: 1_000 + 2_147_483_647 + 10 })
    const failure = expect(pending).rejects.toMatchObject({ code: 'AUTH_TIMEOUT' })
    // Close polling is covered separately; avoid millions of unrelated timer ticks.
    const polling = poll.mock.results[0]!
    if (polling.type !== 'return') throw new Error('Close polling did not start')
    clearInterval(polling.value)
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 10)
    expect(closePopup).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10)
    await failure
    expectClean()
  })

  it.each([
    null,
    [],
    {},
    { type: 1 },
    { type: 'AUTH_SUCCESS' },
    { type: 'AUTH_SUCCESS', payload: null },
    { type: 'AUTH_SUCCESS', payload: [] },
    { type: 'AUTH_SUCCESS', payload: 'not an object' },
    { type: 'AUTH_SUCCESS', payload: { secret: BOT.secret } },
    { type: 'AUTH_SUCCESS', payload: { botid: 1, secret: BOT.secret } },
    { type: 'AUTH_SUCCESS', payload: { botid: '   ', secret: BOT.secret } },
    { type: 'AUTH_SUCCESS', payload: { botid: 'x'.repeat(257), secret: BOT.secret } },
    { type: 'AUTH_SUCCESS', payload: { botid: BOT.botid } },
    { type: 'AUTH_SUCCESS', payload: { botid: BOT.botid, secret: 1 } },
    { type: 'AUTH_SUCCESS', payload: { botid: BOT.botid, secret: '' } },
    { type: 'AUTH_SUCCESS', payload: { botid: BOT.botid, secret: 'x'.repeat(4097) } },
    { type: 'AUTH_SUCCESS', botid: BOT.botid, secret: BOT.secret },
  ])('rejects malformed authorization response %#', async (data) => {
    const pending = adapter.open(OPTIONS)
    send(popup, data)
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expectClean()
  })

  it('accepts the maximum credential lengths', async () => {
    const bot = { botid: 'b'.repeat(256), secret: 's'.repeat(4096) }
    const pending = adapter.open(OPTIONS)
    send(popup, { type: 'AUTH_SUCCESS', payload: bot })
    await expect(pending).resolves.toEqual(bot)
    expectClean()
  })

  it('rejects AUTH_ERROR without exposing provider details or logging credentials', async () => {
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const pending = adapter.open(OPTIONS)
    send(popup, { type: 'AUTH_ERROR', payload: { error: { code: 'provider-error', message: BOT.secret, ...BOT } } })
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(pending).rejects.not.toHaveProperty('secret')
    await expect(pending).rejects.not.toHaveProperty('cause')
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expectClean()
  })

  it('settles even if the browser no longer permits closing the popup', async () => {
    closePopup.mockImplementationOnce(() => { throw new Error('window destroyed') })
    const pending = adapter.open(OPTIONS)
    adapter.cancel()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expectClean()
  })
})
