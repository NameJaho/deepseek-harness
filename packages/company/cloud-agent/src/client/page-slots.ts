/** Saved-Agent action extension points for directory and conversation cards. */
import type { CloudAgentRecord } from '../types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional companion actions on a saved Agent's management card. */
    'company.cloudAgent.page.actions': { kind: 'list'; scope: 'root'; owner: { readonly record: CloudAgentRecord } }
    /** Optional companion actions on a conversation's saved-Agent tool card. */
    'company.cloudAgent.draft.actions': { kind: 'list'; scope: 'session'; owner: { readonly record: CloudAgentRecord } }
  }
}
