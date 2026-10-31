/** Real Loader/profile coverage for parent-visible results reconstructed from persisted logs. */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'
import { ANSWER, httpFixture } from './fixture.ts'

async function logs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? logs(join(dir, entry.name))
    : Promise.resolve(entry.name.endsWith('.jsonl') ? [join(dir, entry.name)] : [])))).flat()
}

describe('external agent through the real Loader and parent tool', () => {
  it.each([false, true])('persists discovery and delivers only complete output or a safe failure (invalid=%s)', async (invalid) => {
    const http = await httpFixture((res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(invalid ? { answer: 'PRIVATE PARTIAL ANSWER' } : ANSWER))
    })
    let events: SessionEvent[] = []
    const result = await runLoaderSmoke({
      label: 'external agent parent delivery', tempDirPrefix: 'external-agent-loader-',
      binScript: fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url)),
      libBinScript: fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url)),
      configPath: fileURLToPath(new URL('./fixtures/external-agent.patch.yml', import.meta.url)),
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
      mode: 'src', sourceImport: 'tsx/esm',
      env: { DSH_EXTERNAL_FIXTURE_ENDPOINT: http.endpoint, DIFY_TEST_KEY: 'fixture-secret' },
      inspect: async (cwd) => {
        const files = await logs(join(cwd, '.sessions'))
        expect(files).toHaveLength(1)
        const text = await readFile(files[0]!, 'utf8')
        expect(text).not.toContain(http.endpoint)
        expect(text).not.toContain('fixture-secret')
        expect(text).not.toContain('PRIVATE PARTIAL ANSWER')
        events = text.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(result.stderr).not.toContain('UNHANDLED')
    expect(http.requests, result.stderr + JSON.stringify(events.filter(event => event.type === 'tool/result'))).toHaveLength(1)
    const body = http.requests[0]!.body
    expect(body.user).toMatch(/^[a-f0-9]{64}$/)
    expect(body).toEqual({ inputs: { language: 'zh' }, query: 'Research this question', response_mode: 'blocking', user: body.user })
    const catalogs = events.filter(event => event.type === 'subagent/catalog')
    expect(catalogs).toHaveLength(1)
    expect(catalogs[0]!.data).toMatchObject({ version: 2, mode: 'external', label: 'Research task' })
    const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')
    expect(notices).toHaveLength(1)
    const notice = notices[0]!
    if (notice.type !== 'user/message' || notice.data.source.kind !== 'subagent-settled') throw new Error('missing settlement')
    expect(catalogs[0]!.data).toMatchObject({ childId: notice.data.source.senderSessionId })
    const receipt = events.find(event => event.type === 'tool/result')
    expect(receipt?.data).toMatchObject({ message: { content: [{ type: 'text', text: `started subagent ${notice.data.source.senderSessionId}` }] } })
    const noticeText = notice.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(noticeText).toContain(invalid ? 'External agent call failed (response-format; effect: unknown).' : ANSWER.answer)
    const final = events.filter(event => event.type === 'assistant/message').at(-1)
    expect(final?.data).toMatchObject({ message: { content: [{ type: 'text', text: invalid ? 'Parent consumed the safe failure.' : 'Parent consumed the external answer.' }] } })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
