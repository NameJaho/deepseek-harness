/** Sanitized company MCP management; tool details are collapsed until explicitly opened. */
import { useState } from 'react'
import { Button, Checkbox, CodeBlock, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { McpInjected } from './mcp-controller.ts'
import type { CompanyMcpServer, CompanyMcpStatus, CompanyMcpTool } from '@deepseek-ai/dsh-company-mcp-provider/types'
import type { CloudAgentLocaleKey } from './locales.ts'
import css from './page.module.css'

type PageProps = PropsRuntime<'plugins.item'> & PropsLocale<'company.cloudAgent'> & InjectFace<McpInjected>
type EntryProps = Pick<PageProps, 't' | 'configureMcp' | 'discoverMcp'> & {
  readonly entry: CompanyMcpServer
  readonly busy: boolean
  readonly canConfigure: boolean
}

/** Every provider state is expressed through text and a semantic color. */
export const mcpStatuses: Record<CompanyMcpStatus, CloudAgentLocaleKey> = {
  available: 'mcpReady', connecting: 'mcpConnecting', failed: 'mcpConnectionFailed', maintenance: 'mcpMaintenance',
}
/** Semantic status colors shared with Agent capability selection. */
export const mcpStatusTones: Record<CompanyMcpStatus, TagTone> = {
  available: 'success', connecting: 'info', failed: 'danger', maintenance: 'warning',
}

interface ParameterRow {
  readonly name: string
  readonly type: string
  readonly description?: string | undefined
  readonly required: boolean
}
interface SchemaPresentation { readonly formatted: string; readonly parameters: readonly ParameterRow[] | undefined }
function recordOf(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function schemaPresentation(source: string): SchemaPresentation {
  let value: unknown
  try { value = JSON.parse(source) } catch (_parseError: unknown) { return { formatted: source, parameters: undefined } }
  const formatted = JSON.stringify(value, null, 2)
  if (!recordOf(value)) return { formatted, parameters: undefined }
  if (value.properties === undefined && value.type === 'object') return { formatted, parameters: [] }
  if (!recordOf(value.properties)) return { formatted, parameters: undefined }
  const required = new Set(Array.isArray(value.required) ? value.required.filter(item => typeof item === 'string') : [])
  return { formatted, parameters: Object.entries(value.properties).map(([name, definition]) => {
    const property = recordOf(definition) ? definition : {}
    const rawType = property.type
    const type = typeof rawType === 'string' ? rawType
      : Array.isArray(rawType) && rawType.every(item => typeof item === 'string') ? rawType.join(' | ') : 'unknown'
    return { name, type, description: typeof property.description === 'string' ? property.description : undefined,
      required: required.has(name) }
  }) }
}

/** Present the parameter table before the copyable complete schema.
 * @param props - sanitized tool and typed copy.
 * @returns an initially collapsed disclosure.
 */
export function ToolDisclosure({ tool, t }: { readonly tool: CompanyMcpTool; readonly t: PageProps['t'] }) {
  const schema = schemaPresentation(tool.parametersJson)
  return <details className={css.mcpTool}>
    <summary className={css.mcpToolSummary}>
      <span className={css.mcpToolIdentity}><code>{tool.rawName}</code><span>{tool.description}</span></span>
      <Tag>{schema.parameters === undefined ? t('mcpCustomSchema') : schema.parameters.length === 0 ? t('mcpNoParameters')
        : t('mcpParametersCount', { count: String(schema.parameters.length) })}</Tag>
    </summary>
    <div className={css.mcpToolBody}>
      {schema.parameters !== undefined && schema.parameters.length > 0 && <table className={css.parameterTable}>
        <thead><tr><th>{t('name')}</th><th>{t('mcpParameterType')}</th><th>{t('mcpParameterRequired')}</th><th>{t('description')}</th></tr></thead>
        <tbody>{schema.parameters.map(parameter => <tr key={parameter.name}>
          <td><code>{parameter.name}</code></td><td>{parameter.type}</td>
          <td>{t(parameter.required ? 'mcpRequired' : 'mcpOptional')}</td><td>{parameter.description}</td>
        </tr>)}</tbody>
      </table>}
      <details className={css.mcpSchema}><summary>{t('mcpFullSchema')}</summary>
        <CodeBlock className={css.mcpSchemaCode} code={schema.formatted} lang="json" copyLabel={t('mcpCopy')} copiedLabel={t('mcpCopied')} />
      </details>
    </div>
  </details>
}

function McpEntry({ entry, busy, canConfigure, configureMcp, discoverMcp, t }: EntryProps) {
  return <article className={`${css.card} ${css.mcpCard}`} data-company-mcp={entry.id}>
    <div className={css.cardHeading}><h2>{entry.name}</h2><Tag tone={mcpStatusTones[entry.status]}>{t(mcpStatuses[entry.status])}</Tag>
      {!entry.enabled && <Tag>{t('mcpDisabled')}</Tag>}</div>
    <p className={css.description}>{entry.description || t('mcpListNoDescription')}</p>
    <p className={css.metadata}>{t('mcpToolsCount', { count: String(entry.tools.length) })}</p>
    {entry.updatedAt !== undefined && <p className={css.metadata}>{t('mcpUpdated', { time: new Date(entry.updatedAt).toISOString() })}</p>}
    {canConfigure && <Checkbox label={t('mcpEnabled')} checked={entry.enabled} disabled={busy}
      onChange={(enabled) => { void configureMcp(entry.id, enabled) }} />}
    <Button variant="outline" disabled={busy || !entry.enabled || entry.status === 'maintenance'}
      onClick={() => { void discoverMcp(entry.id) }}>{t('mcpInspect')}</Button>
    <details className={css.mcpTools}><summary>{t('mcpToolsCount', { count: String(entry.tools.length) })}</summary>
      <div className={css.mcpToolList}>{entry.tools.map(tool => <ToolDisclosure key={tool.name} tool={tool} t={t} />)}</div>
    </details>
  </article>
}

/** Render a searchable, filterable provider catalog without connection settings.
 * @param props - framework-bound provider snapshot and management actions.
 * @returns a Plugins summary or the full management page.
 */
export function CompanyMcpPage(props: PageProps) {
  const view = props.useCompanyMcp(state => state)
  const canConfigure = props.useRemoteAccess('companyMcp/configure')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | CompanyMcpStatus>('all')
  if (props.view === 'summary') return props.t('mcpSummary')
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const entries = view.catalog?.servers.filter(entry => (filter === 'all' || (filter === 'enabled' ? entry.enabled : entry.status === filter))
    && terms.every(term => `${entry.name} ${entry.description} ${entry.tools.map(tool => `${tool.name} ${tool.rawName} ${tool.description}`).join(' ')}`
      .toLocaleLowerCase().includes(term))) ?? []
  return <section className={css.mcpPage} aria-busy={view.busy}>
    <div className={css.heading}><p className={css.help}>{props.t('mcpDiscoveryHelp')}</p>
      <Button variant="outline" disabled={view.busy} onClick={() => { void props.refreshMcp() }}>{props.t('mcpRefresh')}</Button></div>
    <div className={css.toolbar}>
      <Input aria-label={props.t('mcpSearch')} placeholder={props.t('mcpSearch')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <label className={css.field}>{props.t('mcpFilter')}<select value={filter} disabled={view.busy} onChange={(event) => {
        const value = event.target.value
        if (value === 'all' || value === 'enabled' || value in mcpStatuses) setFilter(value as typeof filter)
      }}>
        <option value="all">{props.t('mcpAll')}</option><option value="enabled">{props.t('mcpEnabled')}</option>
        {Object.entries(mcpStatuses).map(([value, key]) => <option key={value} value={value}>{props.t(key)}</option>)}
      </select></label>
    </div>
    {view.error && <div className={css.notice} role="alert"><span>{props.t('mcpFailed')}</span>
      <Button variant="outline" disabled={view.busy} onClick={() => { void props.retryMcp() }}>{props.t('retry')}</Button></div>}
    {view.catalog === null && view.loading ? <div className={css.grid} role="status" aria-label={props.t('loading')}>
      {['a', 'b', 'c'].map(key => <div key={key} className={css.skeleton} />)}</div>
      : entries.length === 0 ? <p className={css.empty}>{props.t('mcpEmpty')}</p>
        : <div className={`${css.grid} ${css.mcpGrid}`}>{entries.map(entry => <McpEntry key={entry.id} entry={entry}
          busy={view.busy} canConfigure={canConfigure} configureMcp={props.configureMcp}
          discoverMcp={props.discoverMcp} t={props.t} />)}</div>}
  </section>
}
