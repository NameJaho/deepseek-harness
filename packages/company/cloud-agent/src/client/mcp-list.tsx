/** Read-only MCP list registered beside Agent information and workspace files. */
import { Button, IconLinkOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudAgentInjected } from './controller.ts'
import { agentMcpSelection } from './agent-mcp.ts'
import css from './page.module.css'

type Props = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'company.cloudAgent'>
  & InjectFace<Pick<CloudAgentInjected, 'hooks' | 'refresh'>>

/** Show only this Session's selected MCP names, retaining rows when descriptions are unavailable.
 * @param props - scoped Session, shared catalog and localized reload action.
 * @returns the draft or fixed-release list, a loading skeleton, or an explicit empty state.
 */
export function CloudAgentMcpList(props: Props) {
  const catalog = props.useCloudAgent(state => state.catalog)
  const loading = props.useCloudAgent(state => state.loading)
  const error = props.useCloudAgent(state => state.error)
  const preset = props.useProjection('agentPreset')
  const selection = catalog === null ? undefined : agentMcpSelection(catalog, props.sessionId, preset)
  return <section className={css.info} data-cloud-agent-mcp-list aria-label={props.t('mcpList')} aria-busy={loading}>
    {error !== null && <div className={css.notice} role="alert"><span>{props.t(error)}</span>
      <Button variant="outline" onClick={() => { void props.refresh() }}>{props.t('retry')}</Button></div>}
    {selection === undefined ? loading && <div role="status" aria-label={props.t('loading')}>
      <div className={`${css.skeleton} ${css.mcpListSkeleton}`} />
      <div className={`${css.skeleton} ${css.mcpListSkeleton}`} />
    </div> : selection.kind === 'new' ? <p>{props.t('mcpListNew')}</p>
      : selection.kind === 'unavailable' ? <p>{props.t('mcpListUnavailable')}</p> : <>
        <header className={css.cardHeading}><h2>{selection.kind === 'draft' ? selection.record.draft.name : selection.release.definition.name}</h2>
          <Tag>{selection.kind === 'draft' ? props.t('draft') : selection.release.kind === 'preview'
            ? props.t('preview') : props.t('version', { version: String(selection.release.version) })}</Tag></header>
        <p className={css.metadata}>{props.t('mcpListCount', { count: String(selection.tools.length) })}</p>
        {selection.tools.length === 0 ? <p>{props.t(selection.kind === 'draft' ? 'mcpListDraftEmpty' : 'infoNoMcp')}</p>
          : <ul className={css.infoList}>{selection.tools.map(tool => <li key={tool.name}>
            <code>{tool.name}</code><p>{tool.description === undefined ? props.t('mcpListMissingDescription')
              : tool.description || props.t('mcpListNoDescription')}</p>
          </li>)}</ul>}
      </>}
  </section>
}

/** Keep the MCP glyph visible in both docked and floating tab titles.
 * @param props - framework-owned tab metadata.
 * @returns the link glyph followed by the tab's localized title.
 */
export function CloudAgentMcpTitle({ useTabInfo }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const { tab } = useTabInfo()
  return <><IconLinkOutlineRegular size={16} className={css.mcpTitleIcon} />{tab.title}</>
}
