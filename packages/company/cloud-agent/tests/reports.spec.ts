/** Migrated report validation bounds complete content before durable settlement. */
import { expect, it } from 'vitest'
import { prepareReport } from '../src/reports.ts'

it('prepares complete UTF-8 reports and validates JSON before download', () => {
  expect(prepareReport('评估.md', '题😀答', 20)).toEqual({ name: '评估.md', content: '题😀答', bytes: 10, mediaType: 'text/markdown' })
  expect(prepareReport('eval.json', '{"passed":1}', 30).mediaType).toBe('application/json')
  expect(() => prepareReport('eval.json', '{', 30)).toThrow(expect.objectContaining({ code: 'cloud-agent/invalid-input' }))
})

it.each(['../eval.md', 'dir/eval.csv', 'dir\\eval.txt', '.hidden.md', 'eval.html', 'eval.md\n', 'eval\u0000.md'])('refuses unsafe report filename %j', (name) => {
  expect(() => prepareReport(name, 'report', 100)).toThrow(expect.objectContaining({ code: 'cloud-agent/invalid-input' }))
})

it('refuses empty reports and measures the complete UTF-8 byte ceiling', () => {
  expect(() => prepareReport('eval.md', ' ', 10)).toThrow()
  expect(() => prepareReport('eval.md', '题😀答', 9)).toThrow()
})
