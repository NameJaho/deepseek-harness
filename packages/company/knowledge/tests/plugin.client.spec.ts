// @vitest-environment jsdom
/** Browser plugin registration: Remote mount, locale, Plugins page entry and ordered teardown. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import type { TestContext } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { KnowledgePage } from '../src/client/page.tsx'
import type { KnowledgeInjected } from '../src/client/controller.ts'

async function bench(test: TestContext) {
  const ctx = new Context()
  test.onTestFinished(async () => { await ctx.fiber.dispose() })
  const order: string[] = []
  const unmount = vi.fn(() => { order.push('unmount'); return Promise.resolve() })
  const mounted: TypertRemoteContribution[] = []
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    $mount(contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
      mounted.push(contribution)
      return Promise.resolve(unmount)
    }
  }
  new Remote()
  const api = {
    catalog: vi.fn(() => Promise.resolve({ ok: true as const, value: { sources: [], maxQueryChars: 10 } })),
    test: vi.fn(),
  }
  ctx.provide('remote.companyKnowledge', api)
  ctx.provide('remoteAccess', { whenAccess: (_action: string, install: () => (() => void) | undefined) => {
    install()
    return () => {}
  } })
  ctx.provide('locale', new LocaleRuntime(ctx))
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'plugins.item': { kind: 'list', scope: 'root' } } } as never, () => null)
  return { ctx, slots, api, unmount, mounted, order }
}

it('mounts the Remote namespace, registers the Plugins page entry and loads the catalog', async (test) => {
  const b = await bench(test)
  expect(inject).toEqual(['remoteAccess', 'slots', 'locale', 'remote'])
  let dispose: (() => Promise<void>) | undefined
  await b.ctx.plugin({ inject: [...inject], apply: async (plugin: Context) => { dispose = await apply(plugin) } }).await()
  expect(b.mounted.map(item => item.package)).toEqual(['@deepseek-ai/dsh-company-knowledge'])
  const entry = b.slots.entries('plugins.item').find(item => item.component === KnowledgePage)
  expect(entry).toMatchObject({ locale: 'company.knowledge', options: { id: 'company-knowledge', order: 26 } })
  const label = entry?.options.label
  expect(typeof label === 'function' ? label() : label).toBe('Company knowledge')
  const face = entry?.inject?.(undefined as never) as KnowledgeInjected | undefined
  await vi.waitFor(() => { expect(face?.hooks.companyKnowledge.getSnapshot().catalog).toEqual({ sources: [], maxQueryChars: 10 }) })
  expect(b.api.catalog).toHaveBeenCalledOnce()
  await dispose?.()
  expect(b.slots.entries('plugins.item').some(item => item.component === KnowledgePage)).toBe(false)
  expect(b.unmount).toHaveBeenCalledOnce()
})

it('withdraws the Remote mount when the page registration fails', async (test) => {
  const b = await bench(test)
  vi.spyOn(b.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
  const fiber = b.ctx.plugin({ inject: [...inject], apply: (plugin: Context) => apply(plugin) })
  await expect(fiber.await()).rejects.toThrow('slot failed')
  expect(b.unmount).toHaveBeenCalledOnce()
})
