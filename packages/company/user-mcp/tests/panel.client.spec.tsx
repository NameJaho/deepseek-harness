// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {} from '../src/client/index.ts'
import { UserMcpPanel } from '../src/client/panel.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { UserMcpPreferences } from '../src/types.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const t = ((key: keyof typeof zh, params?: Record<string, string>) =>
  Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), en[key])) as ComponentProps<typeof UserMcpPanel>['t']

const preferences: UserMcpPreferences = {
  selectedIds: ['7'],
  entries: [
    { id: '7' as never, displayName: 'Store goods', description: 'Store sales', environment: 'prod', accessType: 'open' },
    { id: 'inventory' as never, displayName: 'Inventory', description: '', environment: 'prod', accessType: 'authorized' },
  ],
}

function panel(load: () => Promise<UserMcpPreferences>, save: (ids: readonly string[]) => Promise<UserMcpPreferences>) {
  const props = { t, load, save } as ComponentProps<typeof UserMcpPanel>
  return render(<UserMcpPanel {...props} />)
}

describe('user MCP sidebar panel', () => {
  it('shows the member catalog with the stored selection checked', async () => {
    panel(async () => preferences, vi.fn())

    expect((await screen.findByRole<HTMLInputElement>('checkbox', { name: 'Store goods' })).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Inventory' }).checked).toBe(false)
    expect(screen.getByText('1 selected')).toBeTruthy()
  })

  it('saves exactly the checked servers and reports success', async () => {
    const save = vi.fn(async (ids: readonly string[]) => ({ ...preferences, selectedIds: [...ids] }))
    panel(async () => preferences, save)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Inventory' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Saved') })
    expect(save).toHaveBeenCalledWith(['7', 'inventory'])
  })

  it('unchecks a server and saves the smaller selection', async () => {
    const save = vi.fn(async (ids: readonly string[]) => ({ ...preferences, selectedIds: [...ids] }))
    panel(async () => preferences, save)
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Store goods' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => { expect(save).toHaveBeenCalledWith([]) })
  })

  it('explains an empty catalog', async () => {
    panel(async () => ({ selectedIds: [], entries: [] }), vi.fn())

    expect(await screen.findByText('You have no MCP servers available.')).toBeTruthy()
  })

  it('reports a failed read without offering a stale selection', async () => {
    panel(async () => { throw new Error('unavailable') }, vi.fn())

    expect(await screen.findByText('Could not load or save right now. Try again later.')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
})
