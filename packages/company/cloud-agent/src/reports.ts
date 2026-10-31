/** Bounded UTF-8 report content retained by its owning tool-result event. */
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { CloudAgentReport } from './types.ts'

const mediaTypes: Readonly<Record<string, string>> = {
  md: 'text/markdown', csv: 'text/csv', json: 'application/json', txt: 'text/plain',
}

/** Prepare a report for durable tool-result metadata and browser download.
 * @param name - a display filename with an approved text extension; never a filesystem path.
 * @param content - complete report text supplied by the model.
 * @param maxBytes - deployment-owned UTF-8 byte ceiling.
 * @returns validated content; no filesystem or external side effect occurs before result settlement.
 */
export function prepareReport(name: string, content: string, maxBytes: number): CloudAgentReport {
  const extension = name.split('.').at(-1)?.toLowerCase() ?? ''
  const mediaType = mediaTypes[extension]
  const bytes = Buffer.byteLength(content)
  if (mediaType === undefined || name.length > 160 || /[\\/\u0000-\u001f\u007f]/u.test(name)
    || name.startsWith('.') || name.trim() !== name || content.trim() === '' || bytes > maxBytes) {
    throw new RemoteError('cloud-agent/invalid-input', 'Use a plain .md, .csv, .json or .txt filename and a report within the configured byte limit', { reason: 'report' })
  }
  if (extension === 'json') {
    try { JSON.parse(content) } catch (error) {
      throw new RemoteError('cloud-agent/invalid-input', 'The JSON report must contain valid JSON', { reason: 'report-json' }, { cause: error })
    }
  }
  return { name, content, mediaType, bytes }
}
