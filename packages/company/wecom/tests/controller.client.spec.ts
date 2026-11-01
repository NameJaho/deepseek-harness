// @vitest-environment jsdom
/** Authorization admission, credential containment, and Remote teardown ordering. */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStreamItem } from '@deepseek-ai/dsh-api-gateway/client'
import type { WecomBinding, WecomBindingId, WecomRequest, WecomRequestId, WecomSnapshot } from '../src/types.ts'
import { WecomAuthorizationPopup } from '../src/client/authorization.ts'
import { WecomController } from '../src/client/controller.ts'

vi.mock('@wecom/wecom-aibot-sdk', () => { throw new Error('The singleton SDK must not be runtime imported') })

type Api = ConstructorParameters<typeof WecomController>[0]
type Stream = ReturnType<ConstructorParameters<typeof WecomController>[1]>
const REQUEST_ID = 'request-1' as WecomRequestId
const BINDING_ID = 'binding-1' as WecomBindingId
const BOT = { botid: 'bot-id', secret: 'transient-secret' }

function snapshot(): WecomSnapshot {
  return { source: 'deployment-source', requests: [{ id: REQUEST_ID, ownerId: 'local-owner' as WecomRequest['ownerId'],
    agentId: 'agent-1' as WecomRequest['agentId'], releaseId: 'release-1' as WecomRequest['releaseId'],
    name: 'Saved Agent', expiresAt: 11_000, bindingId: null }], bindings: [] }
}

function binding(): WecomBinding {
  const request = snapshot().requests[0]!
  return { id: BINDING_ID, ownerId: 'local-owner' as WecomBinding['ownerId'], botId: BOT.botid, agentId: request.agentId,
    releaseId: request.releaseId, name: request.name, enabled: true, requestId: REQUEST_ID }
}

/** A driven stream with the Gateway's real item interface and awaitable teardown. */
function drivenStream(cleanup: Promise<void> = Promise.resolve(undefined)) {
  const queue: RemoteStreamItem<WecomSnapshot>[] = []
  let wake = Promise.withResolvers<undefined>()
  const ended = Promise.withResolvers<undefined>()
  const aborted = new AbortController()
  let started = false
  let stopping = false
  let failure: Error | undefined
  const dispose = vi.fn(async () => {
    stopping = true
    aborted.abort()
    wake.resolve(undefined)
    if (started) await ended.promise
  })
  const stream: Stream = {
    dispose,
    async *[Symbol.asyncIterator]() {
      started = true
      try {
        while (!stopping) {
          if (queue.length === 0 && failure === undefined) await wake.promise
          if (stopping) return
          if (failure !== undefined) throw failure
          const item = queue.shift()
          if (item !== undefined) yield item
          if (queue.length === 0) wake = Promise.withResolvers<undefined>()
        }
      } finally {
        await cleanup
        ended.resolve(undefined)
      }
    },
  }
  return { stream, dispose,
    publish(value: WecomSnapshot, generation = 1) {
      const accept = vi.fn()
      queue.push({ value, generation, signal: aborted.signal, accept })
      wake.resolve(undefined)
      return accept
    },
    fail(error: Error) { failure = error; wake.resolve(undefined) },
  }
}

const controllers = new Set<WecomController>()
let popup: Window
let closePopup: MockInstance<() => void>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const frame = document.createElement('iframe')
  document.body.append(frame)
  popup = frame.contentWindow!
  Object.defineProperty(popup, 'closed', { configurable: true, value: false })
  closePopup = vi.spyOn(popup, 'close').mockImplementation(() => {})
  vi.spyOn(window, 'open').mockReturnValue(popup)
})

afterEach(async () => {
  await Promise.allSettled([...controllers].map(controller => controller.dispose()))
  controllers.clear()
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.replaceChildren()
})

function fixture(stream = drivenStream()) {
  const api = {
    snapshot: vi.fn<Api['snapshot']>().mockResolvedValue({ ok: true, value: snapshot() }),
    complete: vi.fn<Api['complete']>().mockResolvedValue({ ok: true, value: binding() }),
    setEnabled: vi.fn<Api['setEnabled']>().mockResolvedValue({ ok: true, value: undefined }),
    requestRelease: vi.fn<Api['requestRelease']>().mockResolvedValue({ ok: true, value: snapshot().requests[0]! }),
  }
  const open = vi.fn(() => stream.stream)
  const controller = new WecomController(api, open)
  controllers.add(controller)
  return { controller, face: controller.face(), api, open, ...stream }
}

/** Wait on observable state rather than a guessed number of microtasks. */
function observe(controller: WecomController, ready: () => boolean): Promise<void> {
  if (ready()) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (ready()) { unsubscribe(); resolve() }
    })
  })
}

async function seed(test: ReturnType<typeof fixture>, value = snapshot()): Promise<void> {
  test.controller.start()
  const accepted = test.publish(value)
  await observe(test.controller, () => test.controller.getSnapshot().snapshot === value)
  expect(accepted).toHaveBeenCalledOnce()
}

function succeed(): void {
  window.dispatchEvent(new MessageEvent('message', {
    origin: 'https://work.weixin.qq.com', source: popup, data: { type: 'AUTH_SUCCESS', payload: BOT },
  }))
}

describe('WecomController', () => {
  it('publishes item.value and accepts each snapshot, including a new generation', async () => {
    const test = fixture()
    const observer = vi.fn()
    const unsubscribe = test.controller.subscribe(observer)
    await seed(test)
    test.controller.start()
    expect(test.open).toHaveBeenCalledOnce()
    const updated: WecomSnapshot = { ...snapshot(), bindings: [{ ...binding(), status: 'online' }] }
    const accept = test.publish(updated, 2)
    await observe(test.controller, () => test.controller.getSnapshot().snapshot === updated)
    expect(accept).toHaveBeenCalledOnce()
    expect(test.face.hooks.wecom).toBe(test.controller)
    expect(test.controller.getSnapshot().snapshot).toEqual(updated)
    expect(observer).toHaveBeenCalledTimes(2)
    unsubscribe()
    test.publish(snapshot())
    await Promise.resolve(undefined)
    expect(observer).toHaveBeenCalledTimes(2)
    await test.controller.dispose()
    expect(test.dispose).toHaveBeenCalledOnce()
  })

  it('opens during the gesture and sends credentials only to complete', async () => {
    const test = fixture()
    await seed(test)
    test.open.mockReturnValueOnce(drivenStream().stream)
    const views: string[] = []
    test.controller.subscribe(() => { views.push(JSON.stringify(test.controller.getSnapshot())) })
    const settled = observe(test.controller, () => test.controller.getSnapshot().busy === null && test.api.complete.mock.calls.length > 0)
    test.face.authorize(REQUEST_ID)
    expect(window.open).toHaveBeenCalledOnce()
    expect(new URL(String(vi.mocked(window.open).mock.calls[0]![0])).searchParams.get('source')).toBe('deployment-source')
    expect(test.controller.getSnapshot().busy).toBe(REQUEST_ID)
    succeed()
    await settled
    expect(test.api.complete).toHaveBeenCalledExactlyOnceWith({ requestId: REQUEST_ID, botId: BOT.botid, secret: BOT.secret })
    expect(views.join('')).not.toContain(BOT.secret)
    expect(test.controller.getSnapshot()).toMatchObject({ busy: null, error: null })
    expect(vi.getTimerCount()).toBe(0)
    expect(closePopup).toHaveBeenCalledOnce()
  })

  it('cancels a pending popup on dispose and ignores late credential messages', async () => {
    const test = fixture()
    await seed(test)
    test.face.authorize(REQUEST_ID)
    const view = test.controller.getSnapshot()
    const changed = vi.fn()
    test.controller.subscribe(changed)
    const closing = test.controller.dispose()
    succeed()
    await closing
    test.face.authorize(REQUEST_ID)
    test.face.refresh()
    test.face.setEnabled(BINDING_ID, true)
    test.controller.start()
    expect(test.api.complete).not.toHaveBeenCalled()
    expect(test.api.snapshot).not.toHaveBeenCalled()
    expect(test.api.setEnabled).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledOnce()
    expect(test.controller.getSnapshot()).toBe(view)
    expect(changed).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(closePopup).toHaveBeenCalledOnce()
    const lateObserver = vi.fn()
    test.controller.subscribe(lateObserver)()
    expect(lateObserver).not.toHaveBeenCalled()
  })

  it('does not call complete when success was queued just before disposal', async () => {
    const test = fixture()
    await seed(test)
    test.face.authorize(REQUEST_ID)
    succeed()
    await test.controller.dispose()
    expect(test.api.complete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drains an already-started complete call before teardown settles', async () => {
    const test = fixture()
    await seed(test)
    const result = Promise.withResolvers<Awaited<ReturnType<Api['complete']>>>()
    const started = Promise.withResolvers<undefined>()
    test.api.complete.mockImplementationOnce(() => { started.resolve(undefined); return result.promise })
    test.face.authorize(REQUEST_ID)
    succeed()
    await started.promise
    const view = test.controller.getSnapshot()
    const changed = vi.fn()
    test.controller.subscribe(changed)
    const settled = vi.fn()
    const closing = test.controller.dispose()
    expect(test.controller.dispose()).toBe(closing)
    void closing.then(settled)
    await Promise.resolve(undefined)
    expect(settled).not.toHaveBeenCalled()
    result.resolve({ ok: true, value: binding() })
    await closing
    expect(settled).toHaveBeenCalledOnce()
    expect(test.api.complete).toHaveBeenCalledOnce()
    expect(test.controller.getSnapshot()).toBe(view)
    expect(changed).not.toHaveBeenCalled()
  })

  it('awaits stream cleanup before disposal settles', async () => {
    const cleanup = Promise.withResolvers<undefined>()
    const test = fixture(drivenStream(cleanup.promise))
    await seed(test)
    const settled = vi.fn()
    const closing = test.controller.dispose()
    void closing.then(settled)
    await Promise.resolve(undefined)
    expect(settled).not.toHaveBeenCalled()
    cleanup.resolve(undefined)
    await closing
    expect(settled).toHaveBeenCalledOnce()
  })

  it('drops a stream item delivered during disposal without accepting or publishing it', async () => {
    const test = fixture()
    const delivery = Promise.withResolvers<RemoteStreamItem<WecomSnapshot>>()
    const ended = Promise.withResolvers<undefined>()
    const accept = vi.fn()
    test.stream[Symbol.asyncIterator] = async function*() {
      try { yield await delivery.promise } finally { ended.resolve(undefined) }
    }
    test.dispose.mockImplementationOnce(async () => {
      delivery.resolve({ value: snapshot(), generation: 1, signal: new AbortController().signal, accept })
      await ended.promise
    })
    test.controller.start()
    const view = test.controller.getSnapshot()
    const changed = vi.fn()
    test.controller.subscribe(changed)
    await test.controller.dispose()
    expect(accept).not.toHaveBeenCalled()
    expect(changed).not.toHaveBeenCalled()
    expect(test.controller.getSnapshot()).toBe(view)
  })

  it('drains complete even when stream disposal fails', async () => {
    const test = fixture()
    await seed(test)
    const result = Promise.withResolvers<Awaited<ReturnType<Api['complete']>>>()
    const started = Promise.withResolvers<undefined>()
    test.api.complete.mockImplementationOnce(() => { started.resolve(undefined); return result.promise })
    test.face.authorize(REQUEST_ID)
    succeed()
    await started.promise
    const originalDispose = test.dispose.getMockImplementation()!
    const failure = new Error('stream teardown failed')
    test.dispose.mockImplementationOnce(async () => { await originalDispose(); throw failure })
    const closing = test.controller.dispose()
    const settled = vi.fn()
    void closing.then(settled, settled)
    await Promise.resolve(undefined)
    expect(settled).not.toHaveBeenCalled()
    result.resolve({ ok: true, value: binding() })
    await expect(closing).rejects.toMatchObject({ errors: [failure] })
  })

  it('reserves refresh busy and forbids every overlapping action, then drains its read', async () => {
    const test = fixture()
    await seed(test)
    const result = Promise.withResolvers<Awaited<ReturnType<Api['snapshot']>>>()
    test.api.snapshot.mockReturnValueOnce(result.promise)
    test.face.refresh()
    expect(test.controller.getSnapshot().busy).toBe('refresh')
    test.face.refresh()
    test.face.authorize(REQUEST_ID)
    test.face.setEnabled(BINDING_ID, true)
    expect(test.api.snapshot).toHaveBeenCalledOnce()
    expect(window.open).not.toHaveBeenCalled()
    expect(test.api.setEnabled).not.toHaveBeenCalled()
    const view = test.controller.getSnapshot()
    const settled = vi.fn()
    const closing = test.controller.dispose()
    void closing.then(settled)
    await Promise.resolve(undefined)
    expect(settled).not.toHaveBeenCalled()
    result.resolve({ ok: true, value: { ...snapshot(), source: 'late-source' } })
    await closing
    expect(test.controller.getSnapshot()).toBe(view)
  })

  it('forbids refresh and other mutations during authorization and enablement', async () => {
    const test = fixture()
    await seed(test)
    test.face.authorize(REQUEST_ID)
    test.face.authorize(REQUEST_ID)
    test.face.refresh()
    test.face.setEnabled(BINDING_ID, true)
    expect(window.open).toHaveBeenCalledOnce()
    expect(test.api.snapshot).not.toHaveBeenCalled()
    expect(test.api.setEnabled).not.toHaveBeenCalled()
    const cancelled = observe(test.controller, () => test.controller.getSnapshot().busy === null)
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://work.weixin.qq.com', source: popup, data: { type: 'AUTH_CANCEL' },
    }))
    await cancelled
    expect(test.controller.getSnapshot().notice?.key).toBe('cancelled')
    const enabled = Promise.withResolvers<Awaited<ReturnType<Api['setEnabled']>>>()
    test.api.setEnabled.mockReturnValueOnce(enabled.promise)
    test.face.setEnabled(BINDING_ID, false)
    expect(test.controller.getSnapshot().busy).toBe(BINDING_ID)
    test.face.refresh()
    test.face.authorize(REQUEST_ID)
    test.face.setEnabled(BINDING_ID, true)
    expect(test.api.setEnabled).toHaveBeenCalledExactlyOnceWith(BINDING_ID, false)
    expect(test.api.snapshot).not.toHaveBeenCalled()
    expect(window.open).toHaveBeenCalledOnce()
    const closing = test.controller.dispose()
    enabled.resolve({ ok: true, value: undefined })
    await closing
  })

  it('publishes refresh results and permits the next action only after settlement', async () => {
    const test = fixture()
    const updated = { ...snapshot(), source: 'refreshed-source' }
    test.api.snapshot.mockResolvedValueOnce({ ok: true, value: updated })
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot()).toMatchObject({ snapshot: updated, busy: null, error: null })
    test.face.authorize(REQUEST_ID)
    expect(new URL(String(vi.mocked(window.open).mock.calls[0]![0])).searchParams.get('source')).toBe(updated.source)
  })

  it.each(['blocked', 'expired', 'failed'] as const)('localizes popup failure as %s', async (error) => {
    const test = fixture()
    await seed(test)
    if (error === 'blocked') vi.mocked(window.open).mockReturnValueOnce(null)
    test.face.authorize(REQUEST_ID)
    const settled = observe(test.controller, () => test.controller.getSnapshot().busy === null)
    if (error === 'expired') {
      await vi.advanceTimersByTimeAsync(10_000)
    } else if (error === 'failed') {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://work.weixin.qq.com', source: popup, data: { type: 'AUTH_SUCCESS', payload: { botid: BOT.botid } },
      }))
    }
    await settled
    expect(test.controller.getSnapshot()).toMatchObject({ busy: null, error: null, notice: { key: error, success: false } })
    expect(test.api.complete).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports an unexpected pre-completion browser failure without requiring uncertain-commit recovery', async () => {
    const test = fixture()
    await seed(test)
    vi.spyOn(WecomAuthorizationPopup.prototype, 'open').mockRejectedValueOnce(new Error('browser setup failed'))
    test.face.authorize(REQUEST_ID)
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot()).toMatchObject({ authorizationUncertain: null, error: null,
      notice: { key: 'failed', success: false } })
    expect(test.api.complete).not.toHaveBeenCalled()
    test.face.authorize(REQUEST_ID)
    expect(window.open).toHaveBeenCalledOnce()
  })

  it.each([
    ['wecom/expired', 'expired'], ['wecom/release-changed', 'versionChanged'], ['wecom/limit', 'failed'],
    ['wecom/owner-required', 'failed'], ['wecom/invalid-authorization', 'failed'], ['wecom/already-bound', 'failed'],
    ['wecom/stopping', 'failed'],
  ] as const)('localizes complete rejection %s as %s', async (code, error) => {
    const test = fixture()
    await seed(test)
    test.api.complete.mockResolvedValueOnce({ ok: false, error: new RemoteError(code, 'authorization refused', {}) })
    test.face.authorize(REQUEST_ID)
    const settled = observe(test.controller, () => test.controller.getSnapshot().busy === null)
    succeed()
    await settled
    expect(test.controller.getSnapshot()).toMatchObject({ busy: null, error: null, notice: { key: error, success: false } })
  })

  it('reports refresh and enablement failures without leaving busy set', async () => {
    const test = fixture()
    test.api.snapshot.mockResolvedValueOnce({ ok: false, error: new RemoteError('wecom/stopping', 'stopping', {}) })
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot().error).toBe('statusFailed')
    test.api.setEnabled.mockResolvedValueOnce({ ok: false, error: new RemoteError('wecom/not-found', 'missing', {}) })
    test.face.setEnabled(BINDING_ID, true)
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot().error).toBe('statusFailed')
    expect(test.controller.getSnapshot().notice).toMatchObject({ key: 'enablementFailed', success: false })
    test.api.snapshot.mockRejectedValueOnce(new Error('carrier failure'))
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot().error).toBe('statusFailed')
  })

  it('reports terminal state stream failures and preserves the last snapshot', async () => {
    const test = fixture()
    const current = snapshot()
    await seed(test, current)
    test.fail(new Error('follow failed'))
    await observe(test.controller, () => test.controller.getSnapshot().error === 'statusFailed')
    expect(test.controller.getSnapshot().snapshot).toBe(current)
  })

  it('refuses missing, bound, and expired authorization requests without opening', async () => {
    const test = fixture()
    test.face.authorize(REQUEST_ID)
    expect(test.controller.getSnapshot().notice?.key).toBe('unavailable')
    await seed(test)
    test.face.authorize('missing' as WecomRequestId)
    expect(test.controller.getSnapshot().notice?.key).toBe('unavailable')
    const bound = snapshot()
    bound.requests[0]!.bindingId = BINDING_ID
    await seed(test, bound)
    test.face.authorize(REQUEST_ID)
    const expired = snapshot()
    expired.requests[0]!.expiresAt = 1_000
    await seed(test, expired)
    test.face.authorize(REQUEST_ID)
    expect(test.controller.getSnapshot().notice?.key).toBe('expired')
    expect(window.open).not.toHaveBeenCalled()
    expect(test.api.complete).not.toHaveBeenCalled()
  })

  it.each(['reported', 'thrown'] as const)('keeps %s uncertain completion blocked until explicit refresh succeeds', async (kind) => {
    const test = fixture()
    await seed(test)
    if (kind === 'reported') test.api.complete.mockResolvedValueOnce({ ok: false,
      error: new RemoteError('wecom/authorization-uncertain', 'unconfirmed binding', {}) })
    else test.api.complete.mockRejectedValueOnce(new Error('lost completion response'))
    test.face.authorize(REQUEST_ID)
    succeed()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot()).toMatchObject({ authorizationUncertain: REQUEST_ID,
      error: null, notice: { key: 'authorization-uncertain', success: false } })
    const notice = test.controller.getSnapshot().notice!
    const updated = { ...snapshot(), source: 'new-source' }
    test.publish(updated)
    await observe(test.controller, () => test.controller.getSnapshot().snapshot === updated)
    test.face.dismissNotice(notice.sequence)
    test.face.authorize(REQUEST_ID)
    expect(window.open).toHaveBeenCalledOnce()
    expect(test.api.complete).toHaveBeenCalledOnce()
    expect(test.controller.getSnapshot().authorizationUncertain).toBe(REQUEST_ID)
    test.api.snapshot.mockRejectedValueOnce(new Error('refresh failed'))
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot()).toMatchObject({ authorizationUncertain: REQUEST_ID, error: 'statusFailed' })
    test.face.authorize(REQUEST_ID)
    expect(window.open).toHaveBeenCalledOnce()
    const replacement = drivenStream()
    test.open.mockReturnValueOnce(replacement.stream)
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot()).toMatchObject({ authorizationUncertain: null, error: null,
      notice: { key: 'refreshed', success: true } })
    test.face.authorize(REQUEST_ID)
    expect(window.open).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(test.controller.getSnapshot())).not.toContain(BOT.secret)
  })

  it('preserves snapshot failures through operation outcomes and stale toast dismissals', async () => {
    const test = fixture()
    await seed(test)
    test.fail(new Error('follow failed'))
    await observe(test.controller, () => test.controller.getSnapshot().error === 'statusFailed')
    test.face.setEnabled(BINDING_ID, false)
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    const first = test.controller.getSnapshot().notice!
    expect(first).toMatchObject({ key: 'robotDisabled', success: true })
    expect(test.controller.getSnapshot().error).toBe('statusFailed')
    test.api.setEnabled.mockRejectedValueOnce(new Error('enablement failed'))
    test.face.setEnabled(BINDING_ID, true)
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    const second = test.controller.getSnapshot().notice!
    expect(second).toMatchObject({ key: 'enablementFailed', success: false })
    expect(second.sequence).toBeGreaterThan(first.sequence)
    test.face.dismissNotice(first.sequence)
    expect(test.controller.getSnapshot().notice).toBe(second)
    test.face.dismissNotice(second.sequence)
    expect(test.controller.getSnapshot().notice).toBeNull()
    expect(test.controller.getSnapshot().error).toBe('statusFailed')
  })

  it('reopens a terminal snapshot stream on Retry and consumes its new baseline', async () => {
    const test = fixture()
    await seed(test)
    test.fail(new Error('follow failed'))
    await observe(test.controller, () => test.controller.getSnapshot().error === 'statusFailed')
    const replacement = drivenStream()
    test.open.mockReturnValueOnce(replacement.stream)
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.dispose).toHaveBeenCalledOnce()
    expect(test.open).toHaveBeenCalledTimes(2)
    const latest = { ...snapshot(), bindings: [{ ...binding(), status: 'online' as const }] }
    const accepted = replacement.publish(latest, 2)
    await observe(test.controller, () => test.controller.getSnapshot().snapshot === latest)
    expect(accepted).toHaveBeenCalledOnce()
    expect(test.controller.getSnapshot().error).toBeNull()
    await test.controller.dispose()
    expect(replacement.dispose).toHaveBeenCalledOnce()
  })

  it('does not replace a newer stream frame with an overlapping refresh result', async () => {
    const test = fixture()
    await seed(test)
    const result = Promise.withResolvers<Awaited<ReturnType<Api['snapshot']>>>()
    test.api.snapshot.mockReturnValueOnce(result.promise)
    const replacement = drivenStream()
    test.open.mockReturnValueOnce(replacement.stream)
    test.face.refresh()
    const latest = { ...snapshot(), bindings: [{ ...binding(), status: 'online' as const }] }
    test.publish(latest)
    await observe(test.controller, () => test.controller.getSnapshot().snapshot === latest)
    result.resolve({ ok: true, value: snapshot() })
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot().snapshot).toBe(latest)
  })

  it.each(['failure', 'frame'] as const)('ignores a retired stream %s while refreshing its replacement', async (outcome) => {
    const test = fixture()
    const current = snapshot()
    const release = Promise.withResolvers<undefined>()
    const ended = Promise.withResolvers<undefined>()
    const accepted = vi.fn()
    const retiredAccept = vi.fn()
    const signal = new AbortController().signal
    test.stream[Symbol.asyncIterator] = async function*() {
      try {
        yield { value: current, generation: 1, signal, accept: accepted }
        await release.promise
        if (outcome === 'failure') throw new Error('retired carrier closed')
        yield { value: { ...current, source: 'retired-source' }, generation: 1, signal, accept: retiredAccept }
      } finally { ended.resolve(undefined) }
    }
    test.dispose.mockImplementationOnce(async () => { release.resolve(undefined); await ended.promise })
    test.controller.start()
    await observe(test.controller, () => test.controller.getSnapshot().snapshot === current)
    expect(accepted).toHaveBeenCalledOnce()
    const refreshed = { ...snapshot(), source: 'refreshed-source' }
    test.api.snapshot.mockResolvedValueOnce({ ok: true, value: refreshed })
    const replacement = drivenStream()
    test.open.mockReturnValueOnce(replacement.stream)
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot()).toMatchObject({ snapshot: refreshed, error: null,
      notice: { key: 'refreshed', success: true } })
    expect(retiredAccept).not.toHaveBeenCalled()
    expect(test.open).toHaveBeenCalledTimes(2)
  })

  it('reports successful enablement as a connection request rather than an online confirmation', async () => {
    const test = fixture()
    const current = snapshot()
    await seed(test, current)
    test.face.setEnabled(BINDING_ID, true)
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.api.setEnabled).toHaveBeenCalledExactlyOnceWith(BINDING_ID, true)
    expect(test.controller.getSnapshot()).toMatchObject({ snapshot: current, error: null,
      notice: { key: 'connectRequested', success: true } })
  })

  it('reports opening and ordinary ending failures as persistent status errors', async () => {
    const test = fixture()
    test.open.mockImplementationOnce(() => { throw new Error('opening failed') })
    test.controller.start()
    expect(test.controller.getSnapshot().error).toBe('statusFailed')
    test.stream[Symbol.asyncIterator] = async function*() { yield* [] }
    test.controller.start()
    await test.stream.dispose()
    await observe(test.controller, () => test.controller.getSnapshot().error === 'statusFailed')
    expect(test.controller.getSnapshot().snapshot).toBeNull()
  })

  it('reports refreshed stream opening failures without losing the refreshed snapshot', async () => {
    const test = fixture()
    await seed(test)
    test.open.mockImplementationOnce(() => { throw new Error('opening failed') })
    const refreshed = { ...snapshot(), source: 'refreshed' }
    test.api.snapshot.mockResolvedValueOnce({ ok: true, value: refreshed })
    test.face.refresh()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot()).toMatchObject({ snapshot: refreshed, error: 'statusFailed' })
  })

  it('keeps successful authorization feedback separate from actual connection state', async () => {
    const test = fixture()
    await seed(test)
    const replacement = drivenStream()
    test.open.mockReturnValueOnce(replacement.stream)
    test.api.snapshot.mockResolvedValueOnce({ ok: true, value: {
      ...snapshot(), requests: [{ ...snapshot().requests[0]!, bindingId: BINDING_ID }],
      bindings: [{ ...binding(), status: 'connecting' }],
    } })
    test.face.authorize(REQUEST_ID)
    succeed()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    expect(test.controller.getSnapshot().notice).toMatchObject({ key: 'authorized', success: true })
    expect(test.controller.getSnapshot().snapshot?.bindings).toEqual([{ ...binding(), status: 'connecting' }])
    expect(test.controller.getSnapshot().snapshot?.requests[0]?.bindingId).toBe(BINDING_ID)
    expect(test.open).toHaveBeenCalledTimes(2)
  })

  it('ignores a retired pending frame after authorization commits a binding', async () => {
    const test = fixture()
    await seed(test)
    const replacement = drivenStream()
    test.open.mockReturnValueOnce(replacement.stream)
    test.api.snapshot.mockResolvedValueOnce({ ok: true, value: {
      ...snapshot(), requests: [{ ...snapshot().requests[0]!, bindingId: BINDING_ID }],
      bindings: [{ ...binding(), status: 'connecting' }],
    } })
    test.face.authorize(REQUEST_ID)
    succeed()
    await observe(test.controller, () => test.controller.getSnapshot().busy === null)
    const stale = test.publish(snapshot(), 2)
    await Promise.resolve()
    expect(stale).not.toHaveBeenCalled()
    expect(test.controller.getSnapshot().snapshot?.bindings).toEqual([{ ...binding(), status: 'connecting' }])
  })

  it('reserves teardown ownership before a busy observer disposes the controller', async () => {
    const test = fixture()
    await seed(test)
    let closing: Promise<void> | undefined
    test.controller.subscribe(() => {
      if (test.controller.getSnapshot().busy !== null) closing = test.controller.dispose()
    })
    test.face.authorize(REQUEST_ID)
    await closing
    expect(window.open).not.toHaveBeenCalled()
    expect(test.api.complete).not.toHaveBeenCalled()
  })
})
