/** Deployment policy for official self-built WeCom application login. */
import z from '@deepseek-ai/schemastery'

/** Public identifiers and limits; the app secret is read exclusively from the server environment. */
export interface Config {
  corpId: string
  agentId: string
  publicOrigin: string
  sessionTtlMs: number
  loginAttemptTtlMs: number
  maxLoginAttempts: number
  requestTimeoutMs: number
  maxResponseBytes: number
}

/** Loader validation; enabled deployments must provide identifiers and a public HTTPS origin. */
export const Config: z<Config> = z.object({
  corpId: z.string().pattern(/^ww[A-Za-z0-9]+$/).required(),
  agentId: z.string().pattern(/^[1-9][0-9]*$/).required(),
  publicOrigin: z.string().required(),
  sessionTtlMs: z.natural().min(60_000).default(8 * 60 * 60 * 1000),
  loginAttemptTtlMs: z.natural().min(1000).default(10 * 60 * 1000),
  maxLoginAttempts: z.natural().min(1).default(1000),
  requestTimeoutMs: z.natural().min(1).default(15_000),
  maxResponseBytes: z.natural().min(1).default(1024 * 1024),
})
