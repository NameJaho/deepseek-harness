/** Deterministic parent model: delegate once, then consume the logged settlement. */
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

class MockParent extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.messages.some(message => message.role === 'tool')) {
      const args = JSON.stringify({ description: 'Research task', prompt: 'Research this question' })
      const id = ToolCallId('external-fixture-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'subagent', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'subagent', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    const reply = text.includes('已完成 focused answer') ? 'Parent consumed the external answer.'
      : text.includes('External agent call failed (response-format; effect: unknown).') ? 'Parent consumed the safe failure.'
        : 'Waiting for the external child.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'external-fixture-parent'
export const inject = ['llm']

/** Register the scripted model as the only nondeterministic parent dependency.
 * @param ctx - Loader-owned model registry context.
 */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['mock'], new MockParent())
}
