/** Session-scoped MCP and skill editing; usage sessions display immutable release selections. */
import { useId, useState } from 'react'
import { Button, Checkbox, IconCordisPluginOutlineRegular, Input, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { CloudAgentCapabilities, CloudAgentCatalog, CloudAgentDraft, CloudAgentRecord } from '../types.ts'
import type { CloudAgentInjected } from './controller.ts'
import type { UserMcpPreferences } from '@deepseek-ai/dsh-company-user-mcp/types'
import { agentMcpSelection, isAgentSession } from './agent-mcp.ts'
import { DefaultCapabilities } from './default-capabilities.tsx'
import { mcpStatuses, mcpStatusTones } from './mcp-page.tsx'
import css from './page.module.css'

/** The member's default-Agent selection, shown in conversations that are not Cloud Agents. */
export interface UserMcpInjected {
  readonly load: () => Promise<UserMcpPreferences>
  readonly save: (selectedIds: readonly string[]) => Promise<UserMcpPreferences>
}
type CapabilityProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'company.cloudAgent'>
  & InjectFace<Pick<CloudAgentInjected, 'hooks' | 'refresh' | 'saveCapabilities' | 'prepareEditor' | 'openConversation' | 'clone'> & {
    readonly manageMcp: () => void
    readonly userMcp: UserMcpInjected
  }>
/** Title chip inputs: the copy, the conversation, and the Cloud Agent store read. */
export type CapabilityTitleProps = PropsLocale<'company.cloudAgent'> & Pick<CapabilityProps, 'sessionId' | 'useCloudAgent'>
type NavigationProps = PropsRuntime<'conversation.input.right'> & PropsLocale<'company.cloudAgent'>
  & InjectFace<Pick<CloudAgentInjected, 'hooks' | 'refresh'>> & { readonly revealCapabilities: (sessionId: SessionId) => void }
/** Editable capability fields, excluding executable plugins and connection settings. */
export type CapabilitySelection = Pick<CloudAgentDraft, 'mcpTools' | 'mcpServers' | 'skills' | 'knowledgeSources'>
function toggle<T extends string>(values: readonly T[] | undefined, value: T, checked: boolean): T[] {
  return checked ? [...new Set([...(values ?? []), value])] : (values ?? []).filter(item => item !== value)
}

/** Reusable local form fields for the draft form and scoped sidebar.
 * @param props - authorized catalog, explicit selections and change callback.
 * @returns server/tool/skill choices retaining selected missing names.
 */
export function CapabilityChoices({ catalog, selection, busy, t, onChange }: {
  readonly catalog: CloudAgentCapabilities
  readonly selection: CapabilitySelection
  readonly busy: boolean
  readonly t: CapabilityProps['t']
  readonly onChange: (selection: CapabilitySelection) => void
}) {
  const sectionId = useId()
  const [query, setQuery] = useState('')
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const servers = catalog.mcpServers.filter(server => terms.every(term => `${server.name} ${server.description} ${server.toolNames.map(name =>
    `${name} ${catalog.mcpTools.find(tool => tool.name === name)?.description ?? ''}`).join(' ')}`.toLocaleLowerCase().includes(term)))
  const tools = [...new Set([...catalog.mcpTools.map(tool => tool.name), ...(selection.mcpTools ?? [])])]
  return <>
    <p className={css.metadata}>{t('capabilityDraftScope')}</p>
    <Input aria-label={t('mcpSearch')} placeholder={t('mcpSearch')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
    <section className={css.capabilityPicker} aria-labelledby={`${sectionId}-mcp`}>
      <h3 id={`${sectionId}-mcp`} className={css.capabilityPickerTitle}>{t('mcpServers')}</h3>
      {servers.length === 0 && <p>{t('noMcpServers')}</p>}
      {servers.map(server => <div key={server.id} className={css.capabilityOption}>
        <Checkbox label={server.name} checked={selection.mcpServers?.includes(server.id) === true}
          disabled={busy || (!selection.mcpServers?.includes(server.id) && (!server.enabled || server.status !== 'available'))}
          onChange={(checked) => { onChange({ ...selection, mcpServers: toggle(selection.mcpServers, server.id, checked) }) }} />
        <p>{server.description || t('mcpListNoDescription')}</p><div className={css.capabilityMeta}>
          <Tag tone={mcpStatusTones[server.status]}>{t(mcpStatuses[server.status])}</Tag>{!server.enabled && <Tag>{t('mcpDisabled')}</Tag>}
          <Tag>{t('mcpToolsCount', { count: String(server.toolCount ?? server.toolNames.length) })}</Tag></div>
      </div>)}
      {(selection.mcpServers ?? []).filter(id => !catalog.mcpServers.some(server => server.id === id)).map(id =>
        <Checkbox key={id} label={id} checked disabled={busy} onChange={(checked) => {
          onChange({ ...selection, mcpServers: toggle(selection.mcpServers, id, checked) })
        }} />)}
    </section>
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
    <section className={css.capabilityPicker} aria-labelledby={`${sectionId}-skills`}>
      <h3 id={`${sectionId}-skills`} className={css.capabilityPickerTitle}>{t('skills')}</h3>
      {catalog.skills.length === 0 && <p>{t('noSkills')}</p>}
      {[...new Set([...catalog.skills.map(skill => skill.name), ...(selection.skills ?? [])])].map(name =>
        <div key={name} className={css.capabilityOption}>
          <Checkbox label={name} checked={selection.skills?.includes(name) === true} disabled={busy}
            onChange={(checked) => { onChange({ ...selection, skills: toggle(selection.skills, name, checked) }) }} />
          <p>{catalog.skills.find(skill => skill.name === name)?.description ?? t('mcpListMissingDescription')}</p>
        </div>)}
    </section>
    <section className={css.capabilityPicker} aria-labelledby={`${sectionId}-knowledge`}>
      <h3 id={`${sectionId}-knowledge`} className={css.capabilityPickerTitle}>{t('knowledgeSources')}</h3>
      {catalog.knowledgeSources.length === 0 && <p>{t('noKnowledgeSources')}</p>}
      {[...new Set([...catalog.knowledgeSources.map(source => source.id), ...(selection.knowledgeSources ?? [])])].map((id) => {
        const source = catalog.knowledgeSources.find(item => item.id === id)
        return <div key={id} className={css.capabilityOption}>
          <Checkbox label={source?.name ?? id} checked={selection.knowledgeSources?.includes(id) === true} disabled={busy}
            onChange={(checked) => { onChange({ ...selection, knowledgeSources: toggle(selection.knowledgeSources, id, checked) }) }} />
          <p>{source?.description ?? t('knowledgeSourceMissing')}</p>
        </div>
      })}
    </section>
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

/** Render only this session's MCP and skills, never global plugin data.
 * @param props - scoped session, framework catalog hooks and controlled mutation actions.
 * @returns authoring choices or a read-only release.
 */
/** Pane body: the Cloud Agent's capabilities in an agent conversation, the member's default selection elsewhere.
 * @param props - capability pane props with both sets of injected functions.
 * @returns the panel for the conversation's kind.
 */
export function CapabilitiesBody(props: CapabilityProps) {
  const view = props.useCloudAgent(state => state)
  if (view.catalog !== null && !isAgentSession(view.catalog, props.sessionId)) {
    return <DefaultCapabilities t={props.t} load={props.userMcp.load} save={props.userMcp.save} />
  }
  return <CloudAgentCapabilitiesPanel {...props} />
}

/** Chip text for the capabilities tab: the Agent's name in an agent conversation, the default name elsewhere.
 * @param props - tab title props with the Cloud Agent store.
 * @returns the localized title.
 */
export function CapabilitiesTitle(props: CapabilityTitleProps) {
  const view = props.useCloudAgent(state => state)
  if (view.catalog === null) return <>{props.t('capabilitiesMenu')}</>
  return <>{props.t(isAgentSession(view.catalog, props.sessionId) ? 'capabilitiesTab' : 'defaultCapabilitiesTab')}</>
}

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
          <section className={css.capabilitySection}><h3>{props.t('knowledgeSources')}</h3><ul className={css.infoList}>
            {(selection.release.definition.knowledgeSources ?? []).map(id => <li key={id}><code>{id}</code></li>)}
          </ul></section>
          <section className={css.capabilitySection}><h3>{props.t('skills')}</h3><ul className={css.infoList}>
            {(selection.release.skillSnapshots?.map(skill => ({ name: skill.name, description: skill.description }))
              ?? selection.release.definition.skills?.map(name => ({ name, description: '' })) ?? []).map(skill =>
              <li key={skill.name}>{skill.name}<p>{skill.description}</p></li>)}
          </ul></section>
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
