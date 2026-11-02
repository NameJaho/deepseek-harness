/** Deployment configuration for the authenticated user MCP bridge. */
import z from '@deepseek-ai/schemastery'

/** URLs, platform identity and bounded upstream operation deadlines. Secrets are read from the process environment. */
export interface Config {
  /** Enables the bridge when set for a deployment. */
  enabled: boolean
  /** Streamable HTTP MCP endpoint exposing `queryUserAvailableMcp`. */
  listUrl: string
  /** Platform token-exchange endpoint. */
  exchangeUrl: string
  /** Platform identifier used in the HMAC request headers. */
  platformId: string
  /** Target MCP environment passed to the exchange endpoint. */
  environment: string
  /** Process environment variable containing the list-service API key. */
  listApiKeyEnv: string
  /** Process environment variable containing the platform HMAC secret. */
  platformSecretEnv: string
  /** Timeout for one catalog or token-exchange request, in milliseconds. */
  requestTimeoutMs: number
  /** Timeout for MCP initialization and tool discovery, in milliseconds. */
  connectionTimeoutMs: number
  /** Timeout for one user MCP tool call, in milliseconds. */
  toolCallTimeoutMs: number
  /** Maximum number of servers returned by one catalog request. */
  maxServers: number
  /** How long one Agent reuses its loaded catalog before the next step refreshes it, in milliseconds. */
  catalogTtlMs: number
}

/** Loader schema for the bridge configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  listUrl: z.string().default('https://test-ai-gateway.busyming.com/mcp-servers/get-user-mcp-list'),
  exchangeUrl: z.string().default('https://workflow-engine.busyming.com/token/exchange'),
  platformId: z.string().default('dsh'),
  environment: z.string().default('test'),
  listApiKeyEnv: z.string().default('DSH_MCP_LIST_API_KEY'),
  platformSecretEnv: z.string().default('DSH_MCP_PLATFORM_SECRET'),
  requestTimeoutMs: z.natural().min(1000).default(10_000),
  connectionTimeoutMs: z.natural().min(1000).default(15_000),
  toolCallTimeoutMs: z.natural().min(1000).default(60_000),
  maxServers: z.natural().min(1).max(100).default(100),
  catalogTtlMs: z.natural().default(60_000),
})
