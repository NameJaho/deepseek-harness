/** Model-facing tool for reading and changing the default Agent's user MCP selection during a conversation. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { UserMcpTarget } from '@deepseek-ai/dsh-company-user-mcp/types'

/** Host operations the tool needs; the tool holds no catalog or storage of its own. */
export interface SelectionPort {
  /** Member id for an Agent, or undefined when no member is recorded for its Session. */
  memberOf(agent: Agent): string | undefined
  /** The member's current catalog. */
  catalog(userId: string): Promise<readonly UserMcpTarget[]>
  /** The member's stored selection. */
  selectedIds(userId: string): readonly string[]
  /** Store a selection after checking every id against `catalog`; takes effect from the next step. */
  commit(userId: string, selectedIds: readonly string[], catalog: readonly UserMcpTarget[]): Promise<void>
}

/**
 * Resolve user-supplied names to catalog ids. A name matches an id exactly, or a display name case-insensitively.
 * @param catalog - the member's current catalog.
 * @param names - names or ids given by the model.
 * @returns the matched ids, in input order without duplicates.
 * @throws Error when a name matches nothing or matches more than one server.
 */
export function resolveSelectionNames(catalog: readonly UserMcpTarget[], names: readonly string[]): string[] {
  const ids: string[] = []
  for (const name of names) {
    const wanted = name.trim().toLowerCase()
    const matches = catalog.filter(target => String(target.id) === name.trim() || target.displayName.trim().toLowerCase() === wanted)
    const [match, ...rest] = matches
    if (match === undefined) throw new Error(`MCP "${name}" is not available to this member; use action list to see the choices`)
    if (rest.length > 0) throw new Error(`MCP "${name}" matches more than one server; use its id`)
    const id = String(match.id)
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/** Build the `user_mcp` tool bound to one Agent's member.
 * @param port - Host operations for the member's catalog and selection.
 * @returns a tool that lists the catalog, or adds or removes servers from the selection.
 */
export function selectionTool(port: SelectionPort): ToolDefinition {
  return defineTool({
    name: 'user_mcp',
    description: 'Show or change which of the member\'s MCP servers this conversation may use. Call with action list to see them. '
      + 'Call add or remove only when the member asks to enable or disable a named server; names are the display names or ids from list. '
      + 'Changes apply from the next step; tools from a server are available only after it is selected.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'remove'] },
      names: { type: 'array', items: { type: 'string' }, description: 'Display names or ids to add or remove; required for add and remove.' },
    },
    output: {
      schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args: unknown, exec: ToolRunContext) {
      const agent = exec.agent
      const userId = agent === undefined ? undefined : port.memberOf(agent)
      if (userId === undefined) throw new Error('Sign in with WeCom to choose MCP servers')
      exec.signal.throwIfAborted()
      const parsed = parseArgs(args)
      const catalog = await port.catalog(userId)
      const selected = new Set(port.selectedIds(userId))
      if (parsed.action === 'list') return JSON.stringify({ servers: catalog.map(target => ({
        id: String(target.id), name: target.displayName, selected: selected.has(String(target.id)) })) })
      const ids = resolveSelectionNames(catalog, parsed.names)
      if (parsed.action === 'add') for (const id of ids) selected.add(id)
      else for (const id of ids) selected.delete(id)
      await port.commit(userId, [...selected], catalog)
      return JSON.stringify({ selectedIds: [...selected], changed: ids })
    },
  })
}

/** Validate the model's arguments at the tool boundary.
 * @param args - raw arguments from the model.
 * @returns the action and the names it applies to.
 * @throws Error when the action is unknown or add/remove has no names.
 */
function parseArgs(args: unknown): { action: 'list' | 'add' | 'remove'; names: string[] } {
  const record = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}
  const action = record.action
  if (action !== 'list' && action !== 'add' && action !== 'remove') throw new Error('action must be list, add or remove')
  const names = Array.isArray(record.names) ? record.names.filter((name): name is string => typeof name === 'string' && name.trim() !== '') : []
  if (action !== 'list' && names.length === 0) throw new Error(`action ${action} needs at least one name`)
  return { action, names }
}
