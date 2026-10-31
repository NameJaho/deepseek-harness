// @vitest-environment jsdom
/** Account controls recover the browser identity from `/auth/me` when the index carries none. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import { apply, inject } from '@deepseek-ai/dsh-company-wecom-auth/client'

interface AccountInjected { readonly displayName: string; readonly roleLabel: string }

async function bench(response: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => response))
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestFinished(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const registered = new Set<{ readonly id: string; readonly inject: () => AccountInjected }>()
  ctx.provide('slots', { inject: (_name: string, register: () => () => void) => register(),
    register: (spec: { readonly id: string; readonly inject: () => AccountInjected }) => {
      registered.add(spec)
      return () => { registered.delete(spec) }
    } } as never)
  ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key } as never)
  ctx.provide('connection', { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } } as never)
  await ctx.plugin({ inject, apply })
  return { ctx, registered }
}

it('installs the account action from /auth/me when the index has no injected identity', async () => {
  const { registered } = await bench(new Response(JSON.stringify({ session: { userId: '624536329', displayName: '肖家濠', role: 'user', expiresAt: 1 } }), { status: 200 }))
  await vi.waitFor(() => { expect(registered.size).toBe(1) })
  const [action] = registered
  expect(action?.id).toBe('wecom-account')
  expect(action?.inject()).toMatchObject({ displayName: '肖家濠', roleLabel: 'user' })
})

it('keeps the account action hidden when /auth/me rejects the browser', async () => {
  const { registered } = await bench(new Response('{"session":null}', { status: 401 }))
  await vi.waitFor(() => { expect(console.warn).toHaveBeenCalledWith('[wecom-auth] /auth/me answered 401; account controls are hidden') })
  expect(registered.size).toBe(0)
})
