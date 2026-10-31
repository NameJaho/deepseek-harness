/** Deployment-owned Cloud Agent publication and persistent file limits. */
import z from '@deepseek-ai/schemastery'

/** Publication settings controlled by the deployment, never by an agent author. */
export interface Config {
  /** Absolute root containing a private directory for each session's saved files. */
  workspaceRoot: string
  /** Maximum source bytes retained per published skill, including resources. */
  skillMaxBytes: number
  /** Maximum resource files retained per skill. */
  skillMaxFiles: number
  /** Selectable preset supplying configured MCP connections and skill providers; defaults to standard. */
  capabilityPreset: string
  /** Maximum stored attachment bytes accepted by the conversation text reader. */
  fileReadMaxBytes: number
  /** Largest Unicode-code-point page returned by the conversation text reader. */
  filePageChars: number
  /** Maximum UTF-8 bytes retained in one downloadable conversation report. */
  reportMaxBytes: number
}

/** Validated publication bounds. */
export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(),
  skillMaxBytes: z.natural().min(1024).max(16777216).default(1048576),
  skillMaxFiles: z.natural().min(1).max(1000).default(128),
  capabilityPreset: z.string().min(1).default('standard'),
  fileReadMaxBytes: z.natural().min(1).default(33554432),
  filePageChars: z.natural().min(1).default(6000),
  reportMaxBytes: z.natural().min(1).max(4194304).default(1048576),
})
