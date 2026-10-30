/** Cookie audience, signature and redirect parser regressions without process-global clocks. */
import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { cookie, cookieHeader, hash, hashMatches, readCookie, safeRedirect, signCookie } from '../src/browser.ts'
import type { WecomSessionId } from '../src/types.ts'

describe('enterprise browser credentials', () => {
  it('accepts only the signed authority, encoding and bounded lifetime', () => {
    const secret = randomBytes(32)
    const payload = { version: 1 as const, sessionId: brandString<WecomSessionId>(`s-${randomUUID()}`),
      authority: 'https://agents.example', issuedAt: 1000, expiresAt: 5000 }
    const value = signCookie(payload, secret)
    expect(readCookie(value, secret, payload.authority, 2000, 4000)).toEqual(payload)
    for (const candidate of [undefined, `${value}.extra`, value.replace('v1.', 'v2.'), `${value.slice(0, -1)}!`,
      signCookie({ ...payload, expiresAt: 1000 }, secret)]) {
      expect(readCookie(candidate, secret, payload.authority, 2000, 4000)).toBeUndefined()
    }
    expect(readCookie(value, randomBytes(32), payload.authority, 2000, 4000)).toBeUndefined()
    expect(readCookie(value, secret, 'http://agents.example', 2000, 4000)).toBeUndefined()
    expect(readCookie(value, secret, payload.authority, 5000, 4000)).toBeUndefined()
    expect(readCookie(value, secret, payload.authority, 999, 4000)).toBeUndefined()
    expect(readCookie(value, secret, payload.authority, 2000, 3999)).toBeUndefined()
  })

  it('does not accept duplicate cookies and issues HttpOnly cookies for TLS proxies', () => {
    expect(cookie({ headers: { cookie: 'other=x; session=a' } }, 'session')).toBe('a')
    expect(cookie({ headers: { cookie: 'session=a; session=b' } }, 'session')).toBeUndefined()
    expect(cookieHeader('session', 'signed', true, 60000, '/')).toContain('Path=/; Max-Age=60; HttpOnly; SameSite=Lax; Secure')
    expect(cookieHeader('session', 'signed', true, 60000, '/ai_harness')).toContain('Path=/ai_harness;')
    expect(cookieHeader('session', '', true, 0, '/ai_harness')).toContain('Max-Age=0')
    expect(hashMatches('state', hash('state'))).toBe(true)
    expect(hashMatches('other', hash('state'))).toBe(false)
  })
})

describe('post-login destinations', () => {
  it.each(['https://attacker.invalid/', '//attacker.invalid', '/\\attacker.invalid', '/%2f%2fattacker.invalid', '/%5cattacker.invalid', '/bad%0aheader', '/%XX'])('rejects %s', (value) => {
    expect(safeRedirect(value, ['/'])).toBe('/')
  })
  it('keeps allowed queries while stripping credential and callback parameters', () => {
    expect(safeRedirect('/reports?tab=mine&code=private&state=private&token=private&deviceID=private', ['/reports']))
      .toBe('/reports?tab=mine')
    expect(safeRedirect('/reports/weekly?tab=mine', ['/reports'])).toBe('/reports/weekly?tab=mine')
    expect(safeRedirect('/reports-other', ['/reports'])).toBe('/')
  })
})
