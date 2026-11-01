import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('ships an ordered bundle patch for the company WeCom service', async () => {
  const patch = await readFile(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
  expect(patch).toContain('id: company-wecom')
  expect(patch).toContain('@deepseek-ai/dsh-company-wecom')
})
