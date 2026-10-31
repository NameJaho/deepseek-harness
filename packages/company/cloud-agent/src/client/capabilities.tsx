/** Session-scoped MCP, skill and knowledge editing; usage sessions display immutable release selections. */
import { useState } from 'react'
import { Button, Checkbox, IconCordisPluginOutlineRegular, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CloudAgentCapabilities, CloudAgentCatalog, CloudAgentDraft, CloudAgentRecord } from '../types.ts'
import type { CloudAgentInjected } from './controller.ts'
import { agentMcpSelection } from './agent-mcp.ts'
import { mcpStatuses, mcpStatusTones } from './mcp-page.tsx'
import css from './page.module.css'

type CapabilityProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'company.cloudAgent'>
  & InjectFace<Pick<CloudAgentInjected, 'hooks' | 'refresh' | 'saveCapabilities' | 'prepareEditor' | 'openConversation' | 'clone'> & {
    readonly manageMcp: () => void
  }>
type NavigationProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'company.cloudAgent'>
  & InjectFace<Pick<CloudAgentInjected, 'hooks' | 'refresh'>> & { readonly revealCapabilities: (sessionId: SessionId) => void }
/** Editable capability fields, excluding executable plugins and connection settings. */
export type CapabilitySelection = Pick<CloudAgentDraft, 'mcpTools' | 'mcpServers' | 'skills' | 'knowledgeSources'>
function toggle<T extends string>(values: readonly T[] | undefined, value: T, checked: boolean): T[] {
  return checked ? [...new Set([...(values ?? []), value])] : (values ?? []).filter(item => item !== value)
}

/** Reusable local form fields for the draft form and scoped sidebar.
 * @param props - authorized catalog, explicit selections and change callback.
 * @returns server/tool/skill/knowledge choices retaining selected missing names.
 */
export function CapabilityChoices({ catalog, selection, busy, t, onChange }: {
  readonly catalog: CloudAgentCapabilities
  readonly selection: CapabilitySelection
  readonly busy: boolean
  readonly t: CapabilityProps['t']
  readonly onChange: (selection: CapabilitySelection) => void
}) {
  const [query, setQuery] = useState('')
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const servers = catalog.mcpServers.filter(server => terms.every(term => `${server.name} ${server.description} ${server.toolNames.map(name =>
    `${name} ${catalog.mcpTools.find(tool => tool.name === name)?.description ?? ''}`).join(' ')}`.toLocaleLowerCase().includes(term)))
  const selectedTools = [...new Set([...(selection.mcpTools ?? []), ...catalog.mcpServers
    .filter(server => selection.mcpServers?.includes(server.id)).flatMap(server => server.toolNames)])]
  const tools = [...new Set([...catalog.mcpTools.map(tool => tool.name), ...(selection.mcpTools ?? [])])]
  return <>
    <p className={css.metadata}>{t('mcpServerCount', { count: String(selection.mcpServers?.length ?? 0) })} · {t('mcpToolCount', { count: String(selectedTools.length) })}</p>
    <Input aria-label={t('mcpSearch')} placeholder={t('mcpSearch')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
    <fieldset className={css.capabilityPicker}><legend>{t('mcpServers')}</legend>
      {servers.length === 0 && <p>{t('noMcpServers')}</p>}
      {servers.map(server => <div key={server.id} className={css.capabilityOption}>
        <Checkbox label={server.name} checked={selection.mcpServers?.includes(server.id) === true}
          disabled={busy || (!selection.mcpServers?.includes(server.id) && (!server.enabled || server.status !== 'available'))}
          onChange={(checked) => { onChange({ ...selection, mcpServers: toggle(selection.mcpServers, server.id, checked) }) }} />
        <p>{server.description || t('mcpListNoDescription')}</p><div className={css.capabilityMeta}>
          <Tag tone={mcpStatusTones[server.status]}>{t(mcpStatuses[server.status])}</Tag>{!server.enabled && <Tag>{t('mcpDisabled')}</Tag>}
          <Tag>{t('mcpToolsCount', { count: String(server.toolNames.length) })}</Tag></div>
      </div>)}
      {(selection.mcpServers ?? []).filter(id => !catalog.mcpServers.some(server => server.id === id)).map(id =>
        <Checkbox key={id} label={id} checked disabled={busy} onChange={(checked) => {
          onChange({ ...selection, mcpServers: toggle(selection.mcpServers, id, checked) })
        }} />)}
    </fieldset>
    <details className={css.requirements}><summary>{t('mcpTools')}</summary><div className={css.capabilityList}>
      {tools.length === 0 && <p>{t('noMcpTools')}</p>}
      {tools.filter(name => terms.every(term => `${name} ${catalog.mcpTools.find(tool => tool.name === name)?.description ?? ''}`
        .toLocaleLowerCase().includes(term))).map(name => <div className={css.capabilityOption} key={name}>
        <Checkbox label={name} checked={selection.mcpTools?.includes(name) === true} disabled={busy}
          onChange={(checked) => { onChange({ ...selection, mcpTools: toggle(selection.mcpTools, name, checked) }) }} />
        <p>{catalog.mcpTools.find(tool => tool.name === name)?.description ?? t('mcpListMissingDescription')}</p>
        <div className={css.capabilityMeta}>{catalog.mcpServers.filter(server => server.toolNames.includes(name)).map(server =>
          <Tag key={server.id}>{server.name}{selection.mcpServers?.includes(server.id) ? ` · ${t('mcpServerSelected')}` : ''}</Tag>)}</div>
      </div>)}
    </div></details>
    <fieldset className={css.capabilityPicker}><legend>{t('skills')}</legend>
      {catalog.skills.length === 0 && <p>{t('noSkills')}</p>}
      {[...new Set([...catalog.skills.map(skill => skill.name), ...(selection.skills ?? [])])].map(name =>
        <div key={name} className={css.capabilityOption}>
          <Checkbox label={name} checked={selection.skills?.includes(name) === true} disabled={busy}
            onChange={(checked) => { onChange({ ...selection, skills: toggle(selection.skills, name, checked) }) }} />
          <p>{catalog.skills.find(skill => skill.name === name)?.description ?? t('mcpListMissingDescription')}</p>
        </div>)}
    </fieldset>
    {(catalog.knowledgeSources !== undefined || (selection.knowledgeSources?.length ?? 0) > 0)
      && <fieldset className={css.capabilityPicker}><legend>{t('knowledgeSources')}</legend>
        {(catalog.knowledgeSources?.length ?? 0) === 0 && <p>{t('noKnowledge')}</p>}
        {[...new Set([...(catalog.knowledgeSources ?? []).map(source => source.id), ...(selection.knowledgeSources ?? [])])].map((id) => {
          const source = catalog.knowledgeSources?.find(item => item.id === id)
          return <div key={id} className={css.capabilityOption}>
            <Checkbox label={source?.name ?? id} checked={selection.knowledgeSources?.includes(id) === true} disabled={busy}
              onChange={(checked) => { onChange({ ...selection, knowledgeSources: toggle(selection.knowledgeSources, id, checked) }) }} />
            <p>{source === undefined ? t('knowledgeMissing') : source.description || t('mcpListNoDescription')}</p>
          </div>
        })}
      </fieldset>}
  </>
}

function CapabilityEditor({ catalog, record, sessionId, busy, t, saveCapabilities, manageMcp }: {
  readonly catalog: CloudAgentCatalog
  readonly record: CloudAgentRecord
  readonly sessionId: SessionId
  readonly busy: boolean
} & Pick<CapabilityProps, 't' | 'saveCapabilities' | 'manageMcp'>) {
  const [base, setBase] = useState(record)
  const [selection, setSelection] = useState<CapabilitySelection>(record.draft)
  const [dirty, setDirty] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [failed, setFailed] = useState(false)
  const stale = conflict || base.revision !== record.revision
  const save = async (): Promise<void> => {
    if (stale || busy) return
    const result = await saveCapabilities(record.id, base.revision, selection, sessionId)
    if (result === undefined || 'authoringRequired' in result) { setFailed(true); return }
    if ('conflictRevision' in result) { setConflict(true); return }
    setBase(result); setSelection(result.draft); setDirty(false); setFailed(false)
  }
  return <>
    <header className={css.cardHeading}><h2>{base.draft.name}</h2><Tag>{t('draft')}</Tag></header>
    <p>{t('capabilityDraftHint')}</p>
    <Button variant="outline" disabled={busy} onClick={manageMcp}>{t('capabilityAddMcp')}</Button>
    <CapabilityChoices catalog={catalog.capabilities} selection={selection} busy={busy} t={t}
      onChange={(next) => { setSelection(next); setDirty(true) }} />
    {stale && <div role="alert" className={css.notice}><span>{t('conflict')}</span>
      <Button variant="outline" disabled={busy} onClick={() => { setBase(record); setSelection(record.draft); setDirty(false); setConflict(false); setFailed(false) }}>{t('reloadDraft')}</Button></div>}
    {failed && !stale && <div role="alert" className={css.notice}><span>{t('failed')}</span>
      <Button variant="outline" disabled={busy} onClick={() => { void save() }}>{t('retry')}</Button></div>}
    <div className={css.capabilityFooter}><span>{t(dirty ? 'capabilityUnsaved' : 'capabilitySaved')}</span>
      <Button variant="primary" disabled={!dirty || busy || stale} onClick={() => { void save() }}>{t('capabilitySave')}</Button></div>
  </>
}

/** Render only this session's MCP, skills and knowledge sources, never global plugin data.
 * @param props - scoped session, framework catalog hooks and controlled mutation actions.
 * @returns authoring choices or a read-only release.
 */
export function CloudAgentCapabilitiesPanel(props: CapabilityProps) {
  const view = props.useCloudAgent(state => state)
  const preset = props.useProjection('agentPreset')
  const selection = view.catalog === null ? undefined : agentMcpSelection(view.catalog, props.sessionId, preset)
  const edit = async (): Promise<void> => {
    if (selection?.kind !== 'release' || view.busy) return
    if (selection.record === undefined) { await props.clone(selection.id, selection.release.id); return }
    const id = await props.prepareEditor(selection.id)
    if (id !== undefined) props.openConversation(id)
  }
  return <section className={css.info} data-cloud-agent-capabilities aria-busy={view.busy}>
    {view.error !== null && <div role="alert" className={css.notice}><span>{props.t(view.error)}</span>
      <Button variant="outline" disabled={view.loading} onClick={() => { void props.refresh() }}>{props.t('retry')}</Button></div>}
    {selection === undefined ? view.loading && <div className={css.infoLoading} role="status" aria-label={props.t('loading')}><StateDot state="ongoing" size={24} /></div>
      : selection.kind === 'draft' && view.catalog !== null ? <CapabilityEditor key={selection.record.id} catalog={view.catalog} record={selection.record}
        sessionId={props.sessionId} busy={view.busy} t={props.t} saveCapabilities={props.saveCapabilities} manageMcp={props.manageMcp} />
        : selection.kind === 'release' ? <>
          <header className={css.cardHeading}><h2>{selection.release.definition.name}</h2><Tag>{props.t('version', { version: String(selection.release.version) })}</Tag></header>
          <p>{props.t('capabilityReleaseHint')}</p>
          <p>{props.t('mcpServerCount', { count: String(selection.release.definition.mcpServers?.length ?? 0) })} · {props.t('mcpToolCount', { count: String(selection.tools.length) })}</p>
          <section className={css.capabilitySection}><h3>{props.t('mcpServers')}</h3><ul className={css.infoList}>
            {(selection.release.definition.mcpServers ?? []).map(id => <li key={id}><code>{id}</code></li>)}
          </ul></section>
          <section className={css.capabilitySection}><h3>{props.t('mcpTools')}</h3>
            {selection.tools.length === 0 ? <p>{props.t('infoNoMcp')}</p> : <ul className={css.infoList}>{selection.tools.map(tool =>
              <li key={tool.name}><code>{tool.name}</code><p>{tool.description ?? props.t('mcpListMissingDescription')}</p></li>)}</ul>}
          </section>
          <section className={css.capabilitySection}><h3>{props.t('skills')}</h3><ul className={css.infoList}>
            {(selection.release.skillSnapshots?.map(skill => ({ name: skill.name, description: skill.description }))
              ?? selection.release.definition.skills?.map(name => ({ name, description: '' })) ?? []).map(skill =>
              <li key={skill.name}>{skill.name}<p>{skill.description}</p></li>)}
          </ul></section>
          <section className={css.capabilitySection}><h3>{props.t('knowledgeSources')}</h3>
            {(selection.release.knowledgeBindings?.length ?? 0) === 0 ? <p>{props.t('infoNoKnowledge')}</p> : <ul className={css.infoList}>
              {selection.release.knowledgeBindings?.map(({ id }) => {
                const source = view.catalog?.capabilities.knowledgeSources?.find(item => item.id === id)
                return <li key={id}>{source?.name ?? id}<p>{source?.description ?? props.t('knowledgeMissing')}</p></li>
              })}</ul>}
          </section>
          <Button variant="outline" disabled={view.busy} onClick={() => { void edit() }}>{props.t(selection.record === undefined ? 'clone' : 'editAgent')}</Button>
        </> : <p>{props.t(selection.kind === 'new' ? 'capabilityNewHint' : 'capabilityUnavailableHint')}</p>}
  </section>
}

/** Open the existing right sidebar without changing the selected conversation.
 * @param props - scoped conversation and sidebar action.
 * @returns a capability tab action for associated Agent sessions.
 */
export function CloudAgentCapabilitiesNavigation(props: NavigationProps) {
  const catalog = props.useCloudAgent(state => state.catalog)
  if (!catalog?.conversations.some(item => item.sessionId === props.sessionId && item.deletedAt === undefined)) return null
  return <Button variant="ghost" icon={<IconCordisPluginOutlineRegular />} onClick={() => { props.revealCapabilities(props.sessionId) }}>{props.t('capabilitiesTab')}</Button>
}
