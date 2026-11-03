import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

describe('user MCP client entry', () => {
  it('declares the remote service it reads and mounts its Remote namespace', async () => {
    expect(inject).toContain('remote')
    const unmount = vi.fn(async () => {})
    const $mount = vi.fn(async () => unmount)
    const teardown = await apply({ remote: { $mount } } as never)
    expect($mount).toHaveBeenCalledOnce()
    await teardown()
    expect(unmount).toHaveBeenCalledOnce()
  })
})
