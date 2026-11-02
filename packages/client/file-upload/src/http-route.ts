/** Authenticated raw-byte upload route registered on the Connection fetch registry. */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { RemoteAccessService } from '@deepseek-ai/dsh-api-remote-access'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { FileUploads } from './index.ts'
import type { FileUploadValue, ImageUploadValue } from './types.ts'

type FileUploadHttpResult =
  | { readonly ok: true; readonly value: FileUploadValue | ImageUploadValue }
  | {
    readonly ok: false
    readonly error: { readonly code: string; readonly message: string; readonly details: object }
  }

type FileUploadPeer = Pick<PeerScope, 'principal'>
type FileUploadAccess = Pick<RemoteAccessService, 'decide'>

/**
 * Handle one authenticated raw-byte upload. A `mediaType` query parameter
 * stages the body as a prompt image; without it the body is stored verbatim.
 * @param service - Host upload service receiving streamed bytes.
 * @param request - authenticated HTTP request from Connection.
 * @param peer - authenticated Peer that owns the request.
 * @param access - access policy used to authorize the addressed Session.
 * @returns 403 when the Peer cannot upload to the addressed Session; otherwise a JSON result using HTTP status 200.
 */
export async function handleFileUploadHttp(
  service: FileUploads,
  request: Request,
  peer: FileUploadPeer,
  access: FileUploadAccess,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/octet-stream', { status: 415 })
  }
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  if (sessionId === null || sessionId === '') {
    return new Response('sessionId is required', { status: 400 })
  }
  const addressedSessionId = brandString<SessionId>(sessionId)
  if (access.decide({
    principal: peer.principal,
    action: 'fileUploads/upload',
    resources: [{ kind: 'session', id: addressedSessionId }],
  }).kind !== 'allow') {
    return new Response('forbidden', { status: 403 })
  }
  const name = url.searchParams.get('name') ?? undefined
  const imageMediaType = url.searchParams.get('mediaType') ?? undefined
  const upload = {
    sessionId: addressedSessionId,
    data: requestBodyChunks(request.body),
    signal: request.signal,
    ...(name === undefined ? {} : { name }),
  }
  let result: FileUploadHttpResult
  try {
    result = {
      ok: true,
      value: imageMediaType === undefined
        ? await service.uploadStream(upload)
        : await service.uploadImageStream({ ...upload, mediaType: imageMediaType }),
    }
  } catch (error) {
    const failure = remoteErrorOf(error)
    result = {
      ok: false,
      error: failure !== undefined
        ? { code: failure.code, message: failure.message, details: failure.details }
        : {
          code: 'gateway/internal',
          message: error instanceof Error ? error.message : String(error),
          details: {},
        },
    }
  }
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

async function* requestBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (body === null) return
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    reader.releaseLock()
  }
}
