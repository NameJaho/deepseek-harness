// @vitest-environment jsdom
/** Client mount rollback and quiescent unload of all robot UI contributions. */
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import type { WecomInjected } from '../src/client/controller.ts'
import type { WecomSnapshot } from '../src/types.ts'

// This suite owns mount ordering; the built browser scenario exercises generated codecs.
vi.mock('@deepseek-ai/dsh-company-wecom/remote', () => ({ default: {} }))

async function fixture(test: { onTestFinished: (cleanup: () => Promise<void>) => void }) {
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SlotRegistry)
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  slots.register({ name: 'root', children: {
    'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    'plugins.item': { kind: 'list', scope: 'root' },
    'shell.overlay': { kind: 'list', scope: 'root' },
    'company.cloudAgent.page.release.actions': { kind: 'list', scope: 'root' },
  } } as never, () => null)
  const end = Promise.withResolvers<undefined>()
  const cleanup = Promise.withResolvers<undefined>()
  test.onTestFinished(async () => { end.resolve(undefined); cleanup.resolve(undefined) })
  const unmount = vi.fn(async () => {})
  const api = { follow: vi.fn(() => ({})) }
  const snapshot: WecomSnapshot = { source: 'test', requests: [], bindings: [] }
  const stream = {
    dispose: vi.fn(async () => { end.resolve(undefined); await cleanup.promise }),
    async *[Symbol.asyncIterator]() {
      yield { value: snapshot, accept: () => {} }
      await end.promise
      await cleanup.promise
    },
  }
  const remote = {
    companyWecom: api,
    $mount: vi.fn(async () => unmount),
    $stream: vi.fn((options: { open: (signal: AbortSignal) => unknown; ended: () => Error }) => {
      options.open(new AbortController().signal)
      expect(options.ended().message).toBe('WeCom snapshot stream ended')
      return stream
    }),
  }
  ctx.provide('remote', remote)
  ctx.provide('remote.companyWecom', api)
  return { ctx, slots, locale, remote, api, stream, snapshot, cleanup, unmount }
}

it('removes every registration and waits for stream cleanup before unmounting Remote', async (test) => {
  const h = await fixture(test)
  const dispose = await apply(h.ctx)
  test.onTestFinished(async () => { h.cleanup.resolve(undefined); await dispose() })
  const injected: object = h.slots.entries('shell.overlay')[0]!.inject!()
  const face = injected as WecomInjected
  await vi.waitFor(() => { expect(face.hooks.wecom.getSnapshot().snapshot).toEqual(h.snapshot) })
  expect(h.slots.entries('tool.call.toolview')).toHaveLength(0)
  const entry = h.slots.entries('plugins.item')[0]!
  expect(resolveSlotLabel(entry.options.label)).toBe('WeCom robots')
  expect(entry.inject!()).toBe(face)
  const closing = dispose()
  await vi.waitFor(() => { expect(h.stream.dispose).toHaveBeenCalledOnce() })
  expect(h.unmount).not.toHaveBeenCalled()
  h.cleanup.resolve(undefined)
  await closing
  expect(h.unmount).toHaveBeenCalledOnce()
  expect(h.slots.entries('tool.call.toolview')).toEqual([])
  expect(h.slots.entries('plugins.item')).toEqual([])
  expect(h.slots.entries('shell.overlay')).toEqual([])
})

it('releases a mounted Remote contribution when UI initialization fails', async (test) => {
  const h = await fixture(test)
  vi.spyOn(h.locale, 'register').mockImplementationOnce(() => { throw new Error('Dictionary unavailable') })
  const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
  test.onTestFinished(async () => { warn.mockRestore() })
  await expect(apply(h.ctx)).rejects.toThrow('Dictionary unavailable')
  expect(h.unmount).toHaveBeenCalledOnce()
  expect(h.remote.$stream).not.toHaveBeenCalled()
  expect(h.slots.entries('shell.overlay')).toEqual([])
})
