/** Download a complete text report from persisted tool-result metadata. */
import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import css from './page.module.css'

const reportSchema = z.object({ name: z.string().min(1), content: z.string(), bytes: z.number().int().nonnegative(),
  mediaType: z.enum(['text/markdown', 'text/csv', 'application/json', 'text/plain']) })

/** Show a recorded report with a download action that requires no remote filesystem.
 * @param props - persisted tool metadata, phase and localized copy.
 * @returns download card or a localized failure with the original tool details available.
 */
export function CloudAgentReportCard(props: ToolCallViewProps & PropsLocale<'company.cloudAgent'>) {
  const [failed, setFailed] = useState(false)
  const downloads = useRef(new Set<string>())
  useEffect(() => {
    const urls = downloads.current
    return () => { for (const url of urls) URL.revokeObjectURL(url) }
  }, [])
  if (props.phase !== 'result') return <div className={css.chatCard} role="status">{props.t('reportPreparing')}</div>
  const meta = props.block.meta
  const parsed = reportSchema.safeParse(typeof meta === 'object' && meta !== null && 'companyReport' in meta ? meta.companyReport : undefined)
  if (props.block.isError || !parsed.success) return <div className={css.chatCard} role="alert">
    <span>{props.t('reportFailed')}</span><Button variant="ghost" onClick={props.inspect}>{props.t('details')}</Button>
  </div>
  const report = parsed.data
  return <article className={css.chatCard} data-company-report={report.name}>
    <div className={css.cardHeading}><h2>{report.name}</h2><Tag>{props.t('reportBytes', { bytes: String(report.bytes) })}</Tag></div>
    <Button variant="outline" onClick={() => {
      try {
        const url = URL.createObjectURL(new Blob([report.content], { type: `${report.mediaType};charset=utf-8` }))
        downloads.current.add(url)
        const link = document.createElement('a')
        link.href = url; link.download = report.name
        link.click()
        setFailed(false)
      } catch (_downloadError: unknown) { setFailed(true) }
    }}>{props.t('reportDownload')}</Button>
    {failed && <p role="alert">{props.t('reportDownloadFailed')}</p>}
  </article>
}
