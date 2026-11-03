/** File-backed per-member selection of user MCP servers; a member with no record has selected none. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z as schema } from 'zod'

const fileSchema = schema.record(schema.string(), schema.array(schema.string()))

/** Durable map from platform user id to the selected user MCP ids, persisted as one JSON file. */
export class PreferenceStore {
  private readonly records: Map<string, readonly string[]>
  private writes: Promise<void> = Promise.resolve()

  private constructor(private readonly file: string, records: Map<string, readonly string[]>) {
    this.records = records
  }

  /**
   * Load the store, or start empty when the file does not exist yet.
   * @param file - absolute path of the JSON file; its directory is created on first write.
   * @returns the loaded store.
   * @throws Error when the file exists but is not a valid selection record.
   */
  static async open(file: string): Promise<PreferenceStore> {
    let text: string
    try { text = await readFile(file, 'utf8') } catch (error) {
      if (isMissing(error)) return new PreferenceStore(file, new Map())
      throw error
    }
    const parsed = fileSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new Error(`company-user-mcp: preferences file ${file} is invalid`)
    return new PreferenceStore(file, new Map(Object.entries(parsed.data)))
  }

  /**
   * Selected user MCP ids for one member.
   * @param userId - platform user id of the verified member.
   * @returns the selected ids; empty when the member has not selected any.
   */
  get(userId: string): readonly string[] {
    return this.records.get(userId) ?? []
  }

  /**
   * Replace one member's selection and persist it before resolving.
   * @param userId - platform user id of the verified member.
   * @param ids - selected user MCP ids, already checked against the member's catalog.
   * @returns resolves once the file has been written; the in-memory value is restored if the write fails.
   */
  set(userId: string, ids: readonly string[]): Promise<void> {
    const previous = this.records.get(userId)
    this.records.set(userId, ids)
    const write = this.writes.then(() => this.persist())
    this.writes = write.catch(() => undefined)
    return write.catch((error: unknown) => {
      if (previous === undefined) this.records.delete(userId)
      else this.records.set(userId, previous)
      throw error
    })
  }

  /** Write the whole map to a temporary sibling file, then rename it into place. */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.records), null, 2)}\n`, 'utf8')
    await rename(temporary, this.file)
  }
}

/**
 * Whether an error is the filesystem's "file does not exist" result.
 * @param error - caught filesystem error.
 * @returns true for ENOENT.
 */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
