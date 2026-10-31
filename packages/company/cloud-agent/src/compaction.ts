/** Per-preset automatic context compaction for retained company conversations. */
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

/** Mount automatic compaction and large-tool-result pruning in one preset realm.
 * @returns a Loader group shared by Agent authoring, releases and page-design presets.
 */
export function cloudAgentCompaction(): PresetDefinition['plugins'][number] {
  return {
    name: 'cordis:group', group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { name: '@deepseek-ai/dsh-compaction-basic' },
      { name: '@deepseek-ai/dsh-compaction-tool-result-pruner' },
    ],
  }
}
