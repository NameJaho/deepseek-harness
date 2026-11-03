/** Published Agent information and its invocation methods in the right sidebar. */
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { agentMcpSelection, connectedAgent } from './agent-mcp.ts'
import type { CapabilityTitleProps } from './capabilities.tsx'
import css from './page.module.css'

/** Sidebar inputs: the copy, the conversation, and the Cloud Agent store read. */
export type AgentInfoProps = CapabilityTitleProps

/** Name, version, visibility, the MCP servers and knowledge sources of the published release, and its invocation methods.
 * @param props - tab body props with the Cloud Agent store.
 * @returns the information for an agent conversation, or a notice when none is published.
 */
export function AgentInfoPanel(props: AgentInfoProps) {
  const { t } = props
  const view = props.useCloudAgent(state => state)
  if (view.catalog === null) return <section className={css.info}><p className={css.help}>{t('agentInfoLoading')}</p></section>
  const catalog = view.catalog
  const connected = connectedAgent(catalog, props.sessionId)
  if (connected === undefined) {
    const draft = agentMcpSelection(catalog, props.sessionId).kind === 'draft'
    return <section className={css.info}>
      <h3 className={css.capabilityPickerTitle}>{t('agentInfoTab')}</h3>
      <p className={css.help}>{t(draft ? 'agentInfoUnpublished' : 'agentInfoNotAgent')}</p>
    </section>
  }
  const { definition, version, visibility } = connected.release
  const servers = (definition.mcpServers ?? []).map(id => catalog.capabilities.mcpServers.find(item => item.id === id)?.name ?? id)
  const sources = (definition.knowledgeSources ?? [])
    .map(id => catalog.capabilities.knowledgeSources.find(item => item.id === id)?.name ?? id)
  return <section className={css.info}>
    <h3 className={css.capabilityPickerTitle}>{definition.name}</h3>
    <p className={css.metadata}>
      {t('version', { version: String(version) })} · {t((visibility ?? 'public') === 'private' ? 'privateVisibility' : 'publicVisibility')}
    </p>
    {definition.description === '' ? null : <p className={css.help}>{definition.description}</p>}
    <div className={css.capabilitySection}>
      <h4 className={css.capabilityPickerTitle}>{t('agentInfoMcp')}</h4>
      <div className={css.capabilities}>{servers.length === 0 ? <span className={css.help}>{t('agentInfoNone')}</span> : servers.map(name => <Tag key={name}>{name}</Tag>)}</div>
    </div>
    <div className={css.capabilitySection}>
      <h4 className={css.capabilityPickerTitle}>{t('agentInfoKnowledge')}</h4>
      <div className={css.capabilities}>{sources.length === 0 ? <span className={css.help}>{t('agentInfoNone')}</span> : sources.map(name => <Tag key={name}>{name}</Tag>)}</div>
    </div>
    <div className={css.capabilitySection}>
      <h4 className={css.capabilityPickerTitle}>{t('agentInfoInvocation')}</h4>
      <pre className={css.mcpSchemaCode}>{t('agentInfoInvocationBody')}</pre>
    </div>
  </section>
}
