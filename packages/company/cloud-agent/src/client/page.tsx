/** Agent authoring and publication forms using browser-safe Phase 2 fields. */
import { useState } from 'react'
import { Button, IconGlobeOutlineRegular, Input, Modal, SegmentedControl, Tag, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudAgentDraft, CloudAgentId, CloudAgentRecord, CloudAgentPublicEntry, CloudAgentVisibility } from '../types.ts'
import type { CloudAgentInjected } from './controller.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { CapabilityChoices } from './capabilities.tsx'
import css from './page.module.css'

type PageProps = PropsRuntime<'main'> & InjectFace<CloudAgentInjected> & PropsLocale<'company.cloudAgent'> & PropsRenderSlots<'company.cloudAgent.page.actions'>
type ToastProps = InjectFace<Pick<CloudAgentInjected, 'hooks' | 'dismissNotice'>> & PropsLocale<'company.cloudAgent'>
interface Editor {
  readonly id: CloudAgentId | null
  readonly sessionId: SessionId
  readonly revision: number
  readonly draft: CloudAgentDraft
}

/** @returns the existing globe navigation glyph. */
export function CloudAgentIcon() { return <IconGlobeOutlineRegular /> }
/** @param props - shell-owned outcome source and copy.
 * @returns a transient operation toast, independent of the page lifetime.
 */
export function CloudAgentToast({ useCloudAgent, dismissNotice, t }: ToastProps) {
  const notice = useCloudAgent(state => state.notice)
  return notice === null ? null : <Toast key={notice.id} text={t(notice.key)} {...notice.success ? { tone: 'success' as const } : {}} onDone={dismissNotice} />
}

/** Render owned drafts, public releases and explicit creation/run choices.
 * @param props - framework hooks and serialized management callbacks.
 * @returns the directory and controlled forms.
 */
export function CloudAgentPage(props: PageProps) {
  const { t } = props
  const view = props.useCloudAgent(state => state)
  const [tab, setTab] = useState<'mine' | 'public'>('public')
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [creationPreset, setCreationPreset] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<CloudAgentRecord | null>(null)
  const [publishTarget, setPublishTarget] = useState<CloudAgentRecord | null>(null)
  const [visibility, setVisibility] = useState<CloudAgentVisibility>('public')
  const [runTarget, setRunTarget] = useState<CloudAgentPublicEntry | null>(null)
  const [runPreset, setRunPreset] = useState('')
  const [runModel, setRunModel] = useState('')
  const [validation, setValidation] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [handledRequest, setHandledRequest] = useState(0)
  const catalog = view.catalog
  const terms = query.trim().toLocaleLowerCase()
  const matches = (draft: CloudAgentDraft): boolean => `${draft.name} ${draft.description}`.toLocaleLowerCase().includes(terms)
  const mine = catalog?.mine.filter(record => record.deletedAt === undefined && matches(record.draft)) ?? []
  const published = catalog?.published.filter(entry => matches(entry.release.definition)) ?? []
  const models = catalog?.models.groups.flatMap(group => group.models.map(model => ({
    value: JSON.stringify([group.id, model.id]), provider: group.id, model: model.id, label: `${group.name} / ${model.name}`,
  }))) ?? []
  const presetOptions = view.presets.map(preset =>
    <option key={preset.id} value={preset.id} disabled={preset.broken !== undefined}>{preset.name ?? preset.id}</option>)
  const openEditor = async (record?: CloudAgentRecord): Promise<void> => {
    const sessionId = await props.prepareEditor(record?.id, creationPreset || undefined)
    if (sessionId === undefined) return
    const defaults = catalog?.models.default
    setEditor({ id: record?.id ?? null, sessionId, revision: record?.revision ?? 0, draft: record?.draft ?? {
      name: '', description: '', instructions: '', provider: defaults?.provider ?? '', model: defaults?.model ?? '',
    } })
    setConflict(false); setValidation(false)
  }
  const patch = (change: Partial<CloudAgentDraft>): void => {
    setEditor(current => current === null ? null : { ...current, draft: { ...current.draft, ...change } })
  }
  const requested = catalog?.mine.find(record => record.id === view.editorRequest?.id)
  if (view.editorRequest !== null && view.editorRequest.nonce !== handledRequest && requested !== undefined) {
    setHandledRequest(view.editorRequest.nonce)
    setEditor({ id: requested.id, sessionId: view.editorRequest.sessionId, revision: requested.revision, draft: requested.draft })
    setConflict(false); setValidation(false); setTab('mine')
  }
  const currentRecord = catalog?.mine.find(record => record.id === editor?.id)
  const stale = conflict || (editor?.id !== null && editor !== null && currentRecord?.revision !== editor.revision)
  const commit = async (): Promise<void> => {
    if (editor === null || view.busy || stale) return
    if (!editor.draft.name.trim() || !editor.draft.instructions.trim() || !models.some(model =>
      model.provider === editor.draft.provider && model.model === editor.draft.model)) { setValidation(true); return }
    const result = await props.save(editor.id, editor.revision, editor.draft, editor.sessionId)
    if (result === undefined || 'authoringRequired' in result) return
    if ('conflictRevision' in result) { setConflict(true); return }
    setEditor(null); props.closeEditor(); setTab('mine')
  }
  const dismissEditor = (): void => { if (!view.busy) { setEditor(null); props.closeEditor() } }
  return <section className={css.page}><div className={css.content}>
    <header className={css.heading}><div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div>
      <div className={css.actions}><Button variant="outline" disabled={catalog === null || view.busy} onClick={() => { void openEditor() }}>{t('manualCreate')}</Button>
        <Button variant="primary" disabled={catalog === null || view.busy} onClick={() => { void props.createInChat(undefined, creationPreset || undefined) }}>{t('createInChat')}</Button></div></header>
    <div className={css.toolbar}>
      <SegmentedControl id="cloud-agent-space" label={t('tabs')} value={tab} onChange={setTab} options={[{ value: 'mine', label: t('mine') }, { value: 'public', label: t('public') }]} />
      <Input value={query} onChange={(event) => { setQuery(event.target.value) }} placeholder={t('search')} aria-label={t('search')} />
      <label className={css.field}>{t('creationPreset')}<select value={creationPreset} disabled={view.busy} onChange={(event) => { setCreationPreset(event.target.value) }}>
        <option value="">{t('defaultPreset')}</option>{presetOptions}</select></label>
    </div>
    {view.error !== null && <div className={css.notice} role="alert"><span>{t(view.error)}</span>
      <Button variant="outline" disabled={view.loading} onClick={() => { void props.refresh() }}>{t('retry')}</Button></div>}
    {catalog === null ? view.loading && <div className={css.grid} role="status" aria-label={t('loading')}>
      {['a', 'b', 'c'].map(id => <div key={id} className={css.skeleton} />)}</div>
      : <div id={`cloud-agent-space-${tab}-panel`} role="tabpanel" aria-labelledby={`cloud-agent-space-${tab}`}>
        {(tab === 'mine' ? mine : published).length === 0 && <p className={css.empty}>{t(terms ? 'noMatches' : tab === 'mine' ? 'emptyMine' : 'emptyPublic')}</p>}
        <div className={css.grid}>{tab === 'mine' ? mine.map(record => <article key={record.id} className={css.card}>
          <header className={css.cardHeading}><h2>{record.draft.name}</h2><Tag>{t(record.publishedReleaseId === null ? 'draft' : 'published')}</Tag></header>
          <p className={css.description}>{record.draft.description}</p>
          <p className={css.metadata}>{record.draft.provider} / {record.draft.model}</p>
          <div className={css.actions}>
            <Button variant="outline" disabled={view.busy} onClick={() => { void props.createInChat(record.id) }}>{t('continueAuthoring')}</Button>
            <Button variant="outline" disabled={view.busy} onClick={() => { void openEditor(record) }}>{t('edit')}</Button>
            <Button variant="outline" disabled={view.busy} onClick={() => { void props.preview(record) }}>{t('preview')}</Button>
            <Button variant="primary" disabled={view.busy} onClick={() => { setPublishTarget(record); setVisibility('public') }}>{t(record.publishedReleaseId === null ? 'publish' : 'republish')}</Button>
            {record.publishedReleaseId !== null && <Button variant="ghost" disabled={view.busy} onClick={() => { void props.unpublish(record) }}>{t('unpublish')}</Button>}
            <Button variant="ghost" disabled={view.busy} onClick={() => { setDeleteTarget(record) }}>{t('deleteAgent')}</Button>
            {props.renderSlot('company.cloudAgent.page.actions', { record })}
          </div>
        </article>) : published.map(entry => <article key={entry.release.id} className={css.card}>
          <header className={css.cardHeading}><h2>{entry.release.definition.name}</h2><Tag>{t('version', { version: String(entry.release.version) })}</Tag></header>
          <p className={css.description}>{entry.release.definition.description}</p><p className={css.metadata}>{t('owner')}: {entry.ownerId}</p>
          <p className={css.metadata}>{entry.release.definition.provider} / {entry.release.definition.model}</p>
          <div className={css.capabilities}>{[...new Set([
            ...(entry.release.mcpBindings?.map(binding => binding.name) ?? entry.release.definition.mcpTools ?? []),
            ...(entry.release.definition.skills ?? []),
          ])].map(name => <Tag key={name}>{name}</Tag>)}</div>
          <div className={css.actions}><Button variant="primary" disabled={view.busy} onClick={() => { setRunTarget(entry); setRunPreset(''); setRunModel('') }}>{t('start')}</Button>
            <Button variant="outline" disabled={view.busy} onClick={() => { void props.clone(entry.id, entry.release.id) }}>{t('clone')}</Button></div>
        </article>)}</div>
      </div>}
  </div>
  {editor !== null && <Modal open headless title={t(editor.id === null ? 'create' : 'formTitle')} onClose={dismissEditor} className={css.modal as string}>
    <form className={css.editorForm} onSubmit={(event) => { event.preventDefault(); void commit() }}>
      <h2 className={css.editorTitle}>{t(editor.id === null ? 'create' : 'formTitle')}</h2>
      <div className={css.editorBody}>
        <section className={css.formSection}>
          <h3>{t('basicSettings')}</h3>
          <label className={css.field}>{t('name')}<Input value={editor.draft.name} maxLength={80} disabled={view.busy} onChange={(event) => { patch({ name: event.target.value }) }} /></label>
          <label className={css.field}>{t('description')}<Input value={editor.draft.description} maxLength={500} disabled={view.busy} onChange={(event) => { patch({ description: event.target.value }) }} /></label>
          <label className={css.field}>{t('model')}<select value={JSON.stringify([editor.draft.provider, editor.draft.model])} disabled={view.busy} onChange={(event) => {
            const selected = models.find(model => model.value === event.target.value)
            if (selected !== undefined) patch({ provider: selected.provider, model: selected.model })
          }}><option value="">{t('chooseModel')}</option>{models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
          <label className={css.field}>{t('instructions')}<textarea value={editor.draft.instructions} maxLength={32768} rows={8} disabled={view.busy} onChange={(event) => { patch({ instructions: event.target.value }) }} /></label>
        </section>
        {catalog !== null && <section className={css.formSection}>
          <h3>{t('capabilitySettings')}</h3>
          <CapabilityChoices catalog={catalog.capabilities} selection={editor.draft} busy={view.busy} t={t} onChange={patch} />
        </section>}
        {validation && <p role="alert">{t('validation')}</p>}
        {stale && <div className={css.notice} role="alert"><span>{t('conflict')}</span>
          <Button variant="outline" disabled={view.busy || currentRecord === undefined} onClick={() => {
            if (currentRecord !== undefined) {
              setEditor({ ...editor, revision: currentRecord.revision, draft: currentRecord.draft })
              setConflict(false)
            }
          }}>{t('reloadDraft')}</Button></div>}
      </div>
      <div className={css.editorActions}><Button variant="outline" disabled={view.busy} onClick={dismissEditor}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" disabled={view.busy || stale}>{t('save')}</Button></div>
    </form>
  </Modal>}
  {publishTarget !== null && <Modal open headless title={t('publish')} onClose={() => { if (!view.busy) setPublishTarget(null) }}>
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      void props.publish(publishTarget, undefined, visibility).then((saved) => {
        if (saved) setPublishTarget(null)
      })
    }}>
      <h2>{t('publish')}</h2><p>{publishTarget.draft.name}</p><p>{publishTarget.draft.description}</p>
      <label className={css.field}>{t('visibility')}<select value={visibility} disabled={view.busy} onChange={(event) => { if (event.target.value === 'public' || event.target.value === 'private') setVisibility(event.target.value) }}>
        <option value="public">{t('publicVisibility')}</option><option value="private">{t('privateVisibility')}</option></select></label>
      <div className={css.formActions}><Button variant="outline" disabled={view.busy} onClick={() => { setPublishTarget(null) }}>{t('cancel')}</Button>
        <Button variant="primary" type="submit" disabled={view.busy || catalog?.mine.find(record => record.id === publishTarget.id)?.revision !== publishTarget.revision}>{t('publish')}</Button></div>
    </form>
  </Modal>}
  {deleteTarget !== null && <Modal open headless title={t('deleteAgent')} onClose={() => { if (!view.busy) setDeleteTarget(null) }}>
    <div className={css.form}><h2>{t('deleteAgent')}</h2><p>{t('deleteDescription', { name: deleteTarget.draft.name })}</p>
      <div className={css.formActions}><Button variant="outline" disabled={view.busy} onClick={() => { setDeleteTarget(null) }}>{t('cancel')}</Button>
        <Button variant="outline" className={css.deleteAction} disabled={view.busy} onClick={() => { void props.deleteAgent(deleteTarget).then((deleted) => { if (deleted) setDeleteTarget(null) }) }}>{t('deleteAgent')}</Button></div></div>
  </Modal>}
  {runTarget !== null && <Modal open headless title={t('start')} onClose={() => { if (!view.busy) setRunTarget(null) }}>
    <form className={css.form} onSubmit={(event) => {
      event.preventDefault()
      const selected = models.find(model => model.value === runModel)
      void props.start(runTarget.id, runTarget.release.id,
        { runPreset: runPreset || undefined, provider: selected?.provider, model: selected?.model })
    }}><h2>{runTarget.release.definition.name}</h2>
      <label className={css.field}>{t('runPreset')}<select value={runPreset} disabled={view.busy} onChange={(event) => { setRunPreset(event.target.value) }}><option value="">{t('defaultPreset')}</option>{presetOptions}</select></label>
      <label className={css.field}>{t('model')}<select value={runModel} disabled={view.busy} onChange={(event) => { setRunModel(event.target.value) }}>
        <option value="">{runTarget.release.definition.provider} / {runTarget.release.definition.model}</option>{models.map(model => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
      <div className={css.formActions}><Button variant="outline" disabled={view.busy} onClick={() => { setRunTarget(null) }}>{t('cancel')}</Button><Button variant="primary" type="submit" disabled={view.busy}>{t('start')}</Button></div>
    </form>
  </Modal>}
  </section>
}
