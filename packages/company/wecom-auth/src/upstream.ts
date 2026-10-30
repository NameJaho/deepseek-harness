/** Official WeCom API client; app tokens remain instance-local and never become member credentials. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Config } from './config.ts'
import { WecomAuthError } from './errors.ts'
import type { WecomCorpId, WecomUserId } from './types.ts'

const text = z.string().min(1).max(16384)
const ids = z.array(z.number().int().positive())
// `status: 1` already excludes disabled members; `enable` is checked only when the API returns it.
const memberSchema = z.object({
  userid: text, name: text.optional(), department: ids, enable: z.literal(1).optional(), status: z.literal(1),
})
const appSchema = z.object({
  agentid: z.number().int().positive(),
  allow_userinfos: z.object({ user: z.array(z.object({ userid: text })) }).optional(),
  allow_partys: z.object({ partyid: ids }).optional(),
  allow_tags: z.object({ tagid: ids }).optional(),
})

/** Verified active member visible to this application. */
export interface WecomMemberLogin {
  readonly corpId: WecomCorpId
  readonly userId: WecomUserId
  readonly displayName?: string
  readonly departments: readonly string[]
}

/** Bounded official API operations, aborted when the provider unloads. */
export class WecomOfficial {
  private token: { value: string; expiresAt: number } | undefined
  private pendingToken: Promise<string> | undefined

  /** @param config - public identifiers and request limits.
   * @param secret - server environment app secret; never persisted.
   * @param signal - provider lifetime.
   */
  constructor(private readonly config: Config, private readonly secret: string, private readonly signal: AbortSignal) {}

  /** Exchange a one-time OAuth code and verify active membership and application visibility.
   * @param code - browser callback code; never retained or logged.
   * @returns credential-free verified member; external users and invisible members reject with 403.
   */
  async exchange(code: string): Promise<WecomMemberLogin> {
    // Non-members receive `openid`/`external_userid` instead of `userid`.
    const auth = z.object({ userid: text }).safeParse(await this.api('/auth/getuserinfo', { code }))
    if (!auth.success) throw new WecomAuthError('wecom-auth/forbidden', 403)
    const member = memberSchema.safeParse(await this.api('/user/get', { userid: auth.data.userid }))
    if (!member.success || member.data.userid !== auth.data.userid) throw new WecomAuthError('wecom-auth/forbidden', 403)
    const app = appSchema.safeParse(await this.api('/agent/get', { agentid: this.config.agentId }))
    if (!app.success || String(app.data.agentid) !== this.config.agentId) throw new WecomAuthError('wecom-auth/remote-failure', 502)
    const visible = app.data.allow_userinfos?.user.some(user => user.userid === member.data.userid) === true
    if (!visible && !await this.visibleThroughGroups(member.data.department, member.data.userid,
      app.data.allow_partys?.partyid ?? [], app.data.allow_tags?.tagid ?? [])) {
      throw new WecomAuthError('wecom-auth/forbidden', 403)
    }
    return { corpId: brandString<WecomCorpId>(this.config.corpId), userId: brandString<WecomUserId>(member.data.userid),
      ...member.data.name === undefined ? {} : { displayName: member.data.name },
      departments: member.data.department.map(String) }
  }

  private async visibleThroughGroups(departments: number[], userid: string, parties: number[], tags: number[]): Promise<boolean> {
    const allowed = new Set(parties)
    for (const tagid of tags) {
      const tag = z.object({ userlist: z.array(z.object({ userid: text })), partylist: ids })
        .safeParse(await this.api('/tag/get', { tagid: String(tagid) }))
      if (!tag.success) throw new WecomAuthError('wecom-auth/remote-failure', 502)
      if (tag.data.userlist.some(user => user.userid === userid)) return true
      for (const id of tag.data.partylist) allowed.add(id)
    }
    if (allowed.size === 0) return false
    if (departments.some(id => allowed.has(id))) return true
    const tree = z.object({ department: z.array(z.object({ id: z.number().int().positive(), parentid: z.number().int().nonnegative() })) })
      .safeParse(await this.api('/department/list', {}))
    if (!tree.success) throw new WecomAuthError('wecom-auth/remote-failure', 502)
    const parents = new Map(tree.data.department.map(department => [department.id, department.parentid]))
    for (const department of departments) {
      const seen = new Set<number>()
      let current = department
      while (current !== 0 && !seen.has(current)) {
        seen.add(current)
        if (allowed.has(current)) return true
        const parent = parents.get(current)
        if (parent === undefined) throw new WecomAuthError('wecom-auth/remote-failure', 502)
        current = parent
      }
    }
    return false
  }

  private async api(path: string, parameters: Record<string, string>): Promise<unknown> {
    return this.request(path, { ...parameters, access_token: await this.accessToken() })
  }

  private accessToken(): Promise<string> {
    if (this.token !== undefined && this.token.expiresAt > Date.now()) return Promise.resolve(this.token.value)
    if (this.pendingToken !== undefined) return this.pendingToken
    this.pendingToken = this.loadToken().finally(() => { this.pendingToken = undefined })
    return this.pendingToken
  }

  private async loadToken(): Promise<string> {
    const parsed = z.object({ access_token: text, expires_in: z.number().int().min(1).max(86400) })
      .safeParse(await this.request('/gettoken', { corpid: this.config.corpId, corpsecret: this.secret }))
    if (!parsed.success) throw new WecomAuthError('wecom-auth/remote-failure', 502)
    // The token's documented expiry is reduced by ten percent to avoid expiry during an API operation.
    this.token = { value: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 900 }
    return this.token.value
  }

  private async request(path: string, parameters: Record<string, string>): Promise<unknown> {
    try {
      const url = new URL(`https://qyapi.weixin.qq.com/cgi-bin${path}`)
      url.search = new URLSearchParams(parameters).toString()
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([
        this.signal, AbortSignal.timeout(this.config.requestTimeoutMs),
      ]) })
      if (!response.ok || response.body === null) {
        await response.body?.cancel()
        throw new WecomAuthError('wecom-auth/remote-failure', 502)
      }
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          if (size > this.config.maxResponseBytes) throw new WecomAuthError('wecom-auth/remote-failure', 502)
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!z.object({ errcode: z.literal(0).optional() }).safeParse(input).success) {
        throw new WecomAuthError('wecom-auth/remote-failure', 502)
      }
      return input
    } catch (_untrustedOfficialApiFailure) {
      // Neither fetch errors nor upstream payloads are safe to log: both can contain the app secret or code.
      throw new WecomAuthError('wecom-auth/remote-failure', 502)
    }
  }
}
