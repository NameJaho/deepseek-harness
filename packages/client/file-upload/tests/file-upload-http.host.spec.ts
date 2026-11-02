import { runInNewContext } from 'node:vm'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { handleFileUploadHttp } from '../src/http-route.ts'
import type { FileUploads } from '../src/index.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only member Peer used by upload authorization cases. */
    'test-upload-member': { readonly kind: 'test-upload-member'; readonly member: string }
  }
}

type UploadPeer = Parameters<typeof handleFileUploadHttp>[2]
type UploadAccess = Parameters<typeof handleFileUploadHttp>[3]
type RequestInput = Parameters<typeof request>[0]

const OWNER_PEER = { principal: { kind: 'owner' } } satisfies UploadPeer
const MEMBER_PEER = { principal: { kind: 'test-upload-member', member: 'member-1' } } satisfies UploadPeer

function access(decision: 'allow' | 'deny' = 'allow'): UploadAccess {
  const result: ReturnType<UploadAccess['decide']> = decision === 'allow'
    ? { kind: 'allow' }
    : { kind: 'deny', reason: 'no-allow' }
  return { decide: vi.fn<UploadAccess['decide']>(() => result) }
}

function handle(
  service: FileUploads,
  input: RequestInput = {},
  peer: UploadPeer = OWNER_PEER,
  authorization: UploadAccess = access(),
): Promise<Response> {
  return handleFileUploadHttp(service, request(input), peer, authorization)
}

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  mediaType?: string
  contentType?: string
  body?: Uint8Array
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  if (input.mediaType !== undefined) query.set('mediaType', input.mediaType)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: input.method ?? 'POST',
    headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
    ...(input.body === undefined ? {} : { body: new Blob([Uint8Array.from(input.body).buffer]) }),
  })
}

function uploads(result: unknown): FileUploads & {
  uploadStream: Mock<FileUploads['uploadStream']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadStream = vi.fn<FileUploads['uploadStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result as Awaited<ReturnType<FileUploads['uploadStream']>>
  })
  return {
    uploadedChunks,
    uploadStream,
  } as unknown as FileUploads & {
    uploadStream: Mock<FileUploads['uploadStream']>
    uploadedChunks: Uint8Array[]
  }
}

describe('background file upload Fetch route', () => {
  it('accepts one authenticated streaming POST request', async () => {
    const service = uploads(Promise.resolve({}))
    expect((await handle(service, {
      sessionId: 's1', contentType: 'application/octet-stream',
    })).status).toBe(200)
  })

  it('authorizes a member against the addressed Session before consuming bytes', async () => {
    const service = uploads(Promise.resolve({}))
    const authorization = access()
    const response = await handle(service, {
      sessionId: 's1', contentType: 'application/octet-stream', body: Uint8Array.of(1, 2),
    }, MEMBER_PEER, authorization)

    expect(response.status).toBe(200)
    expect(authorization.decide).toHaveBeenCalledWith({
      principal: MEMBER_PEER.principal,
      action: 'fileUploads/upload',
      resources: [{ kind: 'session', id: 's1' }],
    })
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2)])
  })

  it('rejects a member without Session upload access before reading the body', async () => {
    const service = uploads(Promise.resolve({}))
    const authorization = access('deny')
    const response = await handle(service, {
      sessionId: 'foreign', contentType: 'application/octet-stream', body: Uint8Array.of(1, 2),
    }, MEMBER_PEER, authorization)

    expect(response.status).toBe(403)
    expect(await response.text()).toBe('forbidden')
    expect(service.uploadStream).not.toHaveBeenCalled()
    expect(service.uploadedChunks).toEqual([])
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const service = uploads(Promise.resolve({}))
    const wrongMethod = await handle(service, { method: 'GET' })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const wrongType = await handle(service, { contentType: 'application/json' })
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('content type must be application/octet-stream')

    const missingSession = await handle(service, { contentType: 'application/octet-stream' })
    expect(missingSession.status).toBe(400)
    expect(await missingSession.text()).toBe('sessionId is required')
    expect(service.uploadStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const service = uploads(Promise.resolve(value))
    const response = await handle(service, {
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    })
    expect(service.uploadStream).toHaveBeenCalledOnce()
    const upload = service.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(service.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('stages the body as a prompt image when the request names its media type', async () => {
    const value: Awaited<ReturnType<FileUploads['uploadImageStream']>> = {
      receiptId: 'receipt-2' as never,
      image: { attachmentId: 'image-1' as never, mediaType: 'image/png', bytes: 2, width: 1, height: 1 },
    }
    const imageChunks: Uint8Array[] = []
    const uploadImageStream = vi.fn<FileUploads['uploadImageStream']>(async (input) => {
      for await (const chunk of input.data) imageChunks.push(chunk)
      return value
    })
    const service = Object.assign(uploads(Promise.resolve({})), { uploadImageStream })
    const response = await handle(service, {
      sessionId: 's1', name: 'shot.png', mediaType: 'image/png',
      contentType: 'application/octet-stream', body: Uint8Array.of(7, 8),
    })
    expect(service.uploadStream).not.toHaveBeenCalled()
    expect(uploadImageStream.mock.calls[0]?.[0]).toMatchObject({ sessionId: 's1', name: 'shot.png', mediaType: 'image/png' })
    expect(imageChunks).toEqual([Uint8Array.of(7, 8)])
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = uploads(Promise.reject(new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    )))
    const businessResponse = await handle(business, {
      sessionId: 's1', contentType: 'application/octet-stream',
    })
    expect(business.uploadStream).toHaveBeenCalledOnce()
    const upload = business.uploadStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(await businessResponse.json()).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = uploads(Promise.reject(new Error('disk offline')))
    expect(await (await handle(internal, {
      sessionId: 's1', contentType: 'application/octet-stream',
    })).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as unknown as Error
    const exception = uploads(Promise.reject(foreignError))
    expect(await (await handle(exception, {
      sessionId: 's1', contentType: 'application/octet-stream',
    })).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })
})
