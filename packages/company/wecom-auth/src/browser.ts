/** Cookie signing, browser binding, redirect validation and public HTTP parsing. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { WecomSessionId } from './types.ts'

/** Cookie carrying a signed Host session identifier. */
export const SESSION_COOKIE = 'dsh-wecom-auth'
/** HttpOnly random browser nonce binding login attempts to their initiating browser. */
export const BROWSER_COOKIE = 'dsh-wecom-browser'

const payloadSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().regex(/^s-[a-f0-9-]{36}$/).transform(value => brandString<WecomSessionId>(value)),
  authority: z.string().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
}).strict()

/** Signed cookie payload; tokens and member profile fields are excluded. */
export type CookiePayload = z.infer<typeof payloadSchema>

/** Read one unambiguous request header.
 * @param request - Fetch or node:http request headers.
 * @param name - lower-case header name.
 * @returns one header value, or undefined for an absent or repeated header.
 */
export function header(request: ConnectionTrustRequest, name: string): string | undefined {
  if (request.headers instanceof Headers) return request.headers.get(name) ?? undefined
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Read one cookie without decoding or accepting repeated names.
 * @param request - incoming browser request.
 * @param name - exact cookie name.
 * @returns the sole matching value, or undefined for missing or ambiguous cookies.
 */
export function cookie(request: ConnectionTrustRequest, name: string): string | undefined {
  const pairs = header(request, 'cookie')?.split(';').map(value => value.trim())
    .filter(value => value.startsWith(`${name}=`))
  return pairs?.length === 1 ? pairs[0]?.slice(name.length + 1) : undefined
}

/** Serialize an HttpOnly, SameSite cookie.
 * @param name - plugin-owned cookie name.
 * @param value - base64url or signed cookie value.
 * @param secure - true for HTTPS public origins, including configured TLS proxies.
 * @param lifetimeMs - zero deletes the cookie.
 * @param path - browser path prefix owned by the mounted authentication routes.
 * @returns a Set-Cookie value with no browser-readable credentials.
 */
export function cookieHeader(name: string, value: string, secure: boolean, lifetimeMs: number, path: string): string {
  return `${name}=${value}; Path=${path}; Max-Age=${Math.floor(lifetimeMs / 1000)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
}

/** Sign a session cookie.
 * @param payload - authority and session lifetime.
 * @param secret - persisted Host signing key.
 * @returns versioned, authenticated cookie value.
 */
export function signCookie(payload: CookiePayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `v1.${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** Verify the signature, audience and lifetime of a browser cookie.
 * @param value - untrusted cookie value.
 * @param secret - persisted signing key.
 * @param authority - current public request origin.
 * @param now - current time in milliseconds.
 * @param ttlMs - deployment's maximum cookie lifetime.
 * @returns the verified payload, or undefined when invalid.
 */
export function readCookie(
  value: string | undefined,
  secret: Buffer,
  authority: string,
  now: number,
  ttlMs: number,
): CookiePayload | undefined {
  if (value === undefined || value.length > 4096) return undefined
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) return undefined
  const signature = Buffer.from(encodedSignature, 'base64url')
  const expected = createHmac('sha256', secret).update(body).digest()
  if (signature.toString('base64url') !== encodedSignature || signature.length !== expected.length || !timingSafeEqual(signature, expected)) return undefined
  const bytes = Buffer.from(body, 'base64url')
  if (bytes.toString('base64url') !== body) return undefined
  let input: unknown
  try { input = JSON.parse(bytes.toString('utf8')) }
  catch (_invalidCookieJson) { return undefined }
  const parsed = payloadSchema.safeParse(input)
  if (!parsed.success) return undefined
  const payload = parsed.data
  if (payload.authority !== authority || payload.issuedAt > now || payload.expiresAt <= now
    || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > ttlMs) return undefined
  return payload
}

/** Digest a state or browser binding before storing it.
 * @param value - random browser nonce or state.
 * @returns a SHA-256 hex digest.
 */
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }

/** Compare a supplied state with a persisted digest in constant time.
 * @param value - untrusted state or browser nonce.
 * @param digest - SHA-256 hex digest.
 * @returns whether the digest matches.
 */
export function hashMatches(value: string, digest: string): boolean {
  const expected = Buffer.from(digest, 'hex')
  const actual = createHash('sha256').update(value).digest()
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Normalize and strip credentials from an allowed site-local redirect.
 * @param value - untrusted redirect value.
 * @param prefixes - allowed pathname prefixes.
 * @returns the safe path and query, or `/` for an invalid or disallowed destination.
 */
export function safeRedirect(value: string | null, prefixes: readonly string[]): string {
  if (value === null || !value.startsWith('/') || /^\/\//.test(value) || /[\\\u0000-\u0020]/u.test(value)) return '/'
  const url = new URL(value, 'http://dsh.invalid')
  if (url.pathname === '/login') return '/'
  let decodedPath: string
  try { decodedPath = decodeURIComponent(url.pathname) }
  catch (_malformedRedirectEscape) { return '/' }
  if (url.origin !== 'http://dsh.invalid' || /^\/\//.test(decodedPath) || /[\\\u0000-\u0020]/u.test(decodedPath)
    || !prefixes.some(prefix => prefix === '/' || url.pathname === prefix || url.pathname.startsWith(`${prefix.replace(/\/$/u, '')}/`))) return '/'
  for (const name of [...url.searchParams.keys()]) {
    if (/^(?:code|state|token|accessToken|refreshToken|userId|deviceId)$/iu.test(name)) url.searchParams.delete(name)
  }
  return url.pathname + url.search
}
