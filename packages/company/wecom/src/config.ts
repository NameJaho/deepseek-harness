/** Deployment-owned bounds and official WeCom connection settings. */
import z from '@deepseek-ai/schemastery'

/** Trusted settings; robot Secrets are never plugin configuration. */
export interface Config {
  /** Source identifier passed to the official authorization window. */
  source: string
  /** Official WebSocket endpoint; override only for a private WeCom deployment. */
  wsUrl: string
  /** Authorization request lifetime in milliseconds. */
  authorizationTimeoutMs: number
  /** Maximum duration of one admitted conversation interval. */
  responseTimeoutMs: number
  /** Maximum retained bindings and simultaneously connected robots. */
  maxBindings: number
  /** Maximum waiting messages for one robot. */
  maxQueuedMessages: number
  /** Maximum inbound text length. */
  maxInputChars: number
  /** UTF-8 reply ceiling including the truncation notice. */
  maxReplyBytes: number
  /** Maximum authorization records retained, with expired requests pruned first. */
  maxRequests: number
  /** Maximum retained conversation routes. */
  maxConversations: number
  /** Maximum delivery receipts retained for duplicate suppression. */
  maxReceipts: number
}

/** Validate all deployment-varying limits at plugin activation. */
export const Config: z<Config> = z.object({
  source: z.string().min(1).default('busyming-ai-harness'),
  wsUrl: z.string().pattern(/^wss?:\/\//).default('wss://openws.work.weixin.qq.com'),
  authorizationTimeoutMs: z.number().min(1000).default(600000),
  responseTimeoutMs: z.number().min(1000).default(240000),
  maxBindings: z.number().min(1).max(100).step(1).default(20),
  maxQueuedMessages: z.number().min(1).step(1).default(20),
  maxInputChars: z.number().min(1).step(1).default(16000),
  maxReplyBytes: z.number().min(128).max(20000).step(1).default(20000),
  maxRequests: z.number().min(1).step(1).default(1000),
  maxConversations: z.number().min(1).step(1).default(1000),
  maxReceipts: z.number().min(1).step(1).default(10000),
})
