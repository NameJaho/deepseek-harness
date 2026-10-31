/** Private Session directories and pinned Skill files, independent of execution availability. */
import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { CloudAgentSkillSnapshot } from './types.ts'

/** Owns Session workspace preparation and creation rollback. */
export class SessionWorkspaces {
  /** @param root - absolute deployment root. */
  constructor(private readonly root: string) {}

  /** Prepare private persistent Session storage.
   * @param sessionId - platform Session identity.
   * @returns its private persistent directory.
   */
  async workspace(sessionId: SessionId): Promise<string> {
    const path = join(this.root, createHash('sha256').update(sessionId).digest('hex'))
    await mkdir(path, { recursive: true, mode: 0o700 })
    return path
  }

  /** Remove files created for a Session that failed before publication.
   * @param sessionId - unpublished Session whose creation failed.
   */
  async discardWorkspace(sessionId: SessionId): Promise<void> {
    await rm(join(this.root, createHash('sha256').update(sessionId).digest('hex')), { recursive: true, force: true })
  }

  /** Write pinned Skill instructions and resources into a newly created workspace.
   * @param sessionId - newly created Session.
   * @param skills - immutable release resources.
   */
  async materializeSkills(sessionId: SessionId, skills: readonly CloudAgentSkillSnapshot[]): Promise<void> {
    const root = await this.workspace(sessionId)
    for (const skill of skills) for (const resource of [{ path: 'SKILL.md', base64: Buffer.from(skill.content).toString('base64') }, ...skill.resources]) {
      const path = join(root, '.skills', skill.name, resource.path)
      await mkdir(dirname(path), { recursive: true, mode: 0o755 })
      await writeFile(path, Buffer.from(resource.base64, 'base64'), { flag: 'wx', mode: 0o644 })
    }
  }
}
