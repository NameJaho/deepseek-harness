/** Migrated attachment reads retain full verification and bounded Unicode pages. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { expect, it, type TestContext } from 'vitest'
import { conversationFiles, conversationFilesProjection, readConversationFile } from '../src/files.ts'
import { Config } from '../src/config.ts'

async function fixture(test: TestContext, content: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), 'company-file-read-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  test.onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(AttachmentLocal, { dshHome: root })
  await ctx.plugin(SessionProjections)
  const projection = await ctx.sessionProjections.register(conversationFilesProjection)
  const ref = await ctx.attachments.saveFile({ data: content, name: 'eval.md' })
  const session = Session.create(SessionId('uploaded-eval'))
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] }), { surfaceOp: 'append' })
  return { ctx, projection, ref, session, config: Config({ workspaceRoot: root, filePageChars: 2 } as Config) }
}

it('reads Unicode pages without splitting emoji and retains references after replay and unregistration', async (test) => {
  const { ctx, projection, ref, session, config } = await fixture(test, new TextEncoder().encode('题😀答\n二'))
  const signal = new AbortController().signal
  expect(await readConversationFile(ctx.attachments, ref, { attachmentId: ref.attachmentId }, config, signal))
    .toMatchObject({ text: '题😀', nextOffset: 2, totalChars: 5 })
  expect(await readConversationFile(ctx.attachments, ref, { attachmentId: ref.attachmentId, offset: 2 }, config, signal))
    .toMatchObject({ text: '答\n', nextOffset: 4 })
  const replay = Session.create(SessionId('uploaded-eval-replay'), session.snapshotEvents())
  await projection.dispose()
  expect(conversationFiles(projection, replay)).toEqual([ref])
})

it('rejects binary content and requests exceeding the configured page bound', async (test) => {
  const { ctx, ref, config } = await fixture(test, Uint8Array.from([0, 1, 2]))
  const signal = new AbortController().signal
  await expect(readConversationFile(ctx.attachments, ref, { attachmentId: ref.attachmentId }, config, signal))
    .rejects.toMatchObject({ code: 'cloud-agent/invalid-input', details: { reason: 'file-unreadable' } })
  await expect(readConversationFile(ctx.attachments, ref, { attachmentId: ref.attachmentId, limit: 3 }, config, signal))
    .rejects.toMatchObject({ code: 'cloud-agent/invalid-input', details: { reason: 'file-page' } })
})
