/**
 * Partition memory: what a partition's manager knows across requests.
 *
 * A manager is a fresh child per request, so on its own it starts every request
 * with no idea what the partition did before. This module is the durable part
 * that makes the chain `routing -> manager -> session -> worker` behave like one
 * bot per partition:
 *
 * - a **work log**: one entry per finished task (who, what it did, which files,
 *   what was left, which session), written by the router when a row settles;
 * - **notes**: standing facts about the partition (conventions, pitfalls,
 *   decisions) written by the manager with `partition_memory` or by a human
 *   from the panel;
 * - a **session roster** and a **transcript reader**, so a manager can see every
 *   worker session of its partition and read what one of them actually did.
 *
 * One JSON document per partition under `<boardDir>/memory/<name>.json`. Writes
 * go through a per-file chain and a temp file, like the board.
 *
 * @module host-router/memory
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RouterTask, TaskState } from './board.ts'
import type { SessionEventLike } from './types.ts'

/** Who wrote a note. */
export type NoteAuthor = 'manager' | 'human' | 'router'

/** One standing fact about a partition. */
export interface MemoryNote {
  readonly id: string
  readonly at: string
  readonly text: string
  readonly by: NoteAuthor
  /** Task the note came out of, when a manager wrote it during a request. */
  readonly taskId?: string
}

/** One finished task, as the partition remembers it. */
export interface WorkEntry {
  readonly at: string
  readonly taskId: string
  /** Request (root task) this row belonged to. */
  readonly rootId?: string
  readonly level: 'manager' | 'worker'
  readonly subject: string
  readonly state: TaskState
  readonly summary?: string
  readonly touched?: readonly string[]
  readonly left?: string
  readonly error?: string
  readonly sessionId?: string
  readonly model?: string
}

/** Whole memory of one partition, as persisted. */
export interface PartitionMemory {
  readonly version: 1
  readonly notes: readonly MemoryNote[]
  readonly log: readonly WorkEntry[]
}

/** Limits that keep the document (and the manager prompt) bounded. */
export const NOTE_LIMIT = 80
export const NOTE_TEXT_LIMIT = 600
export const LOG_LIMIT = 300

const EMPTY: PartitionMemory = { version: 1, notes: [], log: [] }

/** File-system-safe stem for a partition name. */
export function memoryFileStem(partition: string): string {
  const stem = partition.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '_')
  return stem === '' ? '_' : stem
}

/** Collapse whitespace and cut to a length, for one-line rendering. */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** Build the work-log entry for one settled row. */
export function entryOf(task: RouterTask, rootId?: string): WorkEntry {
  return {
    at: task.updatedAt,
    taskId: task.id,
    ...rootId === undefined || rootId === task.id ? {} : { rootId },
    level: task.level,
    subject: oneLine(task.subject, 160),
    state: task.state,
    ...task.summary === undefined ? {} : { summary: oneLine(task.summary, 400) },
    ...task.touched === undefined || task.touched.length === 0 ? {} : { touched: task.touched.slice(0, 20) },
    ...task.left === undefined ? {} : { left: oneLine(task.left, 300) },
    ...task.error === undefined ? {} : { error: oneLine(task.error, 200) },
    ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
    ...task.model === undefined ? {} : { model: task.model },
  }
}

/** Accept only a well-formed document; anything else starts empty. */
function normalise(raw: unknown): PartitionMemory {
  if (raw === null || typeof raw !== 'object') return EMPTY
  const candidate = raw as { notes?: unknown; log?: unknown }
  const notes = Array.isArray(candidate.notes)
    ? candidate.notes.filter((note): note is MemoryNote =>
      note !== null && typeof note === 'object'
      && typeof (note as MemoryNote).id === 'string' && typeof (note as MemoryNote).text === 'string')
    : []
  const log = Array.isArray(candidate.log)
    ? candidate.log.filter((entry): entry is WorkEntry =>
      entry !== null && typeof entry === 'object' && typeof (entry as WorkEntry).taskId === 'string')
    : []
  return { version: 1, notes, log }
}

/** Durable per-partition memory. One instance per plugin activation. */
export class MemoryStore {
  private readonly docs = new Map<string, PartitionMemory>()
  private readonly writing = new Map<string, Promise<void>>()

  private constructor(private readonly dir: string) {}

  /**
   * Open the memory directory and load the given partitions.
   * @param dir - `<boardDir>/memory`.
   * @param partitions - partition names to load now; others load on first use.
   */
  static async open(dir: string, partitions: readonly string[] = []): Promise<MemoryStore> {
    await mkdir(dir, { recursive: true })
    const store = new MemoryStore(dir)
    for (const name of partitions) await store.load(name)
    return store
  }

  private fileOf(partition: string): string {
    return join(this.dir, `${memoryFileStem(partition)}.json`)
  }

  private async load(partition: string): Promise<PartitionMemory> {
    const cached = this.docs.get(partition)
    if (cached !== undefined) return cached
    let doc = EMPTY
    try {
      doc = normalise(JSON.parse(await readFile(this.fileOf(partition), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Keep unreadable bytes for forensics; an empty memory beats refusing to start.
        await rename(this.fileOf(partition), `${this.fileOf(partition)}.corrupt-${String(Date.now())}`).catch(() => {})
      }
    }
    this.docs.set(partition, doc)
    return doc
  }

  /** Current memory of one partition (loads it on first use). */
  async read(partition: string): Promise<PartitionMemory> {
    return await this.load(partition)
  }

  /** Synchronous view of an already-loaded partition; empty when not loaded yet. */
  peek(partition: string): PartitionMemory {
    return this.docs.get(partition) ?? EMPTY
  }

  /**
   * Record one settled row. A row recorded again (retried, resumed) replaces its
   * earlier entry, so the log holds the latest outcome once.
   */
  async record(partition: string, entry: WorkEntry): Promise<void> {
    const doc = await this.load(partition)
    const log = [...doc.log.filter(item => item.taskId !== entry.taskId), entry].slice(-LOG_LIMIT)
    await this.save(partition, { ...doc, log })
  }

  /**
   * Fill an empty work log from rows that settled before memory existed.
   * Does nothing when the partition already has a log.
   * @returns how many entries were written.
   */
  async seed(partition: string, entries: readonly WorkEntry[]): Promise<number> {
    const doc = await this.load(partition)
    if (doc.log.length > 0 || entries.length === 0) return 0
    const log = [...entries].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)).slice(-LOG_LIMIT)
    await this.save(partition, { ...doc, log })
    return log.length
  }

  /** Add one note; returns it. */
  async addNote(partition: string, text: string, by: NoteAuthor, taskId?: string): Promise<MemoryNote> {
    const clean = text.trim()
    if (clean === '') throw new Error('a note needs text')
    if (clean.length > NOTE_TEXT_LIMIT) throw new Error(`a note is at most ${String(NOTE_TEXT_LIMIT)} characters; keep it to one fact`)
    const doc = await this.load(partition)
    const note: MemoryNote = {
      id: `n-${randomUUID().slice(0, 8)}`,
      at: new Date().toISOString(),
      text: clean,
      by,
      ...taskId === undefined ? {} : { taskId },
    }
    // Over the limit, the oldest note goes: notes are meant to be few and current.
    const notes = [...doc.notes, note].slice(-NOTE_LIMIT)
    await this.save(partition, { ...doc, notes })
    return note
  }

  /** Remove one note; returns whether it existed. */
  async removeNote(partition: string, id: string): Promise<boolean> {
    const doc = await this.load(partition)
    const notes = doc.notes.filter(note => note.id !== id)
    if (notes.length === doc.notes.length) return false
    await this.save(partition, { ...doc, notes })
    return true
  }

  private async save(partition: string, doc: PartitionMemory): Promise<void> {
    this.docs.set(partition, doc)
    const previous = this.writing.get(partition) ?? Promise.resolve()
    const run = previous.then(async () => {
      const file = this.fileOf(partition)
      const temp = `${file}.tmp-${String(process.pid)}`
      // Write what is current when this write runs, so a burst coalesces.
      await writeFile(temp, JSON.stringify(this.docs.get(partition) ?? doc, undefined, 2), 'utf8')
      try {
        await rename(temp, file)
      } catch (error) {
        await unlink(temp).catch(() => {})
        throw error
      }
    })
    this.writing.set(partition, run.catch(() => {}))
    await run
  }
}

/** Short relative age, for prompts. */
export function ageOf(at: string, now = Date.now()): string {
  const ms = now - Date.parse(at)
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${String(minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${String(hours)}h ago`
  return `${String(Math.round(hours / 24))}d ago`
}

/** One work-log entry as one prompt line. */
export function workLine(entry: WorkEntry, now = Date.now()): string {
  const head = `- ${entry.taskId} [${entry.state}] ${ageOf(entry.at, now)} · ${entry.subject}`
  const parts = [
    entry.summary === undefined ? undefined : `did: ${entry.summary}`,
    entry.touched === undefined ? undefined : `touched: ${entry.touched.slice(0, 6).join(', ')}${entry.touched.length > 6 ? ` +${String(entry.touched.length - 6)}` : ''}`,
    entry.left === undefined ? undefined : `left: ${entry.left}`,
    entry.error === undefined ? undefined : `error: ${entry.error}`,
    entry.sessionId === undefined ? undefined : `session ${entry.sessionId}`,
  ].filter((part): part is string => part !== undefined)
  return parts.length === 0 ? head : `${head}\n    ${parts.join(' | ')}`
}

/** States a roster lists as "open": the session may still change. */
const OPEN_STATES: ReadonlySet<TaskState> = new Set<TaskState>(['queued', 'dispatched', 'running', 'interrupted', 'suspended', 'blocked'])

/**
 * The partition's worker sessions, newest first: open ones always, then the
 * most recent settled ones up to `limit`.
 */
export function sessionRoster(tasks: readonly RouterTask[], limit = 12, now = Date.now()): string[] {
  const withSession = tasks.filter(task => task.level === 'worker' && task.sessionId !== undefined)
  const newest = [...withSession].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const open = newest.filter(task => OPEN_STATES.has(task.state))
  const settled = newest.filter(task => !OPEN_STATES.has(task.state)).slice(0, Math.max(0, limit - open.length))
  return [...open, ...settled].map(task => {
    const did = task.summary === undefined ? '' : ` | did: ${oneLine(task.summary, 160)}`
    const waiting = task.state === 'suspended' && task.suspendReason !== undefined ? ` | suspended: ${oneLine(task.suspendReason, 120)}` : ''
    return `- ${task.id} session ${task.sessionId!} [${task.state}] ${ageOf(task.updatedAt, now)} · ${oneLine(task.subject, 100)}${did}${waiting}`
  })
}

/**
 * Text a manager gets about its partition before the request: notes, recent
 * work, and the worker sessions it can read or continue.
 */
export function memoryBrief(
  memory: PartitionMemory,
  tasks: readonly RouterTask[],
  options: { readonly logLimit?: number; readonly rosterLimit?: number; readonly now?: number } = {},
): string {
  const now = options.now ?? Date.now()
  const logLimit = options.logLimit ?? 20
  const lines: string[] = ['## What this partition remembers']
  lines.push('', '### Notes (standing facts; follow them unless the request says otherwise)')
  if (memory.notes.length === 0) lines.push('(none yet)')
  for (const note of memory.notes) lines.push(`- [${note.id}] ${note.text}`)
  const recent = memory.log.slice(-logLimit).reverse()
  lines.push('', `### Recent work (newest first, ${String(recent.length)} of ${String(memory.log.length)})`)
  if (recent.length === 0) lines.push('(nothing recorded yet)')
  for (const entry of recent) lines.push(workLine(entry, now))
  const roster = sessionRoster(tasks, options.rosterLimit ?? 12, now)
  lines.push('', '### Worker sessions you can read (`session_read`) or continue (`task_resume`)')
  if (roster.length === 0) lines.push('(none yet)')
  lines.push(...roster)
  return lines.join('\n')
}

/** Text of the content blocks of one message-shaped payload. */
export function textBlocks(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((block): string[] => {
    if (block === null || typeof block !== 'object') return []
    const candidate = block as { type?: unknown; text?: unknown }
    return candidate.type === 'text' && typeof candidate.text === 'string' ? [candidate.text] : []
  }).join('\n').trim()
}

/** Short argument preview for a tool call line. */
export function argumentPreview(value: unknown): string {
  if (value === undefined) return ''
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return ''
  }
  return oneLine(text, 160)
}

/**
 * Render the end of a session log as a readable transcript.
 *
 * Reads message-shaped events (`data.message.{role,content}` or
 * `data.{role,content}`), tool calls and their results, and turn ends. Unknown
 * event types are skipped, so a newer harness only loses detail, never breaks.
 * @param events - the session log.
 * @param last - how many rendered entries to keep from the end.
 * @param textLimit - cut for each message body.
 */
export function renderTranscript(events: readonly SessionEventLike[], last = 16, textLimit = 1200): string[] {
  const out: string[] = []
  for (const event of events) {
    const data = event.data as Record<string, unknown> | undefined
    if (event.type === 'tool/call') {
      const name = typeof data?.['name'] === 'string' ? data['name'] : 'tool'
      out.push(`[tool] ${name} ${argumentPreview(data?.['arguments'])}`.trimEnd())
      continue
    }
    if (event.type === 'tool/result') {
      const body = textBlocks(data?.['output'] ?? data?.['content']) || argumentPreview(data?.['output'] ?? data?.['result'])
      if (body !== '') out.push(`[result] ${oneLine(body, 300)}`)
      continue
    }
    if (event.type === 'turn/end') {
      const kind = (data?.['reason'] as { kind?: unknown } | undefined)?.kind
      out.push(`[turn end: ${typeof kind === 'string' ? kind : 'unknown'}]`)
      continue
    }
    const message = (data?.['message'] ?? data) as { role?: unknown; content?: unknown } | undefined
    if (message === undefined || message === null || typeof message !== 'object') continue
    const role = typeof message.role === 'string'
      ? message.role
      : event.type.startsWith('assistant/') ? 'assistant' : event.type.startsWith('user/') ? 'user' : undefined
    if (role !== 'user' && role !== 'assistant') continue
    if (event.type === 'assistant/attempt') continue
    const text = textBlocks(message.content)
    if (text === '') continue
    const body = text.length > textLimit ? `${text.slice(0, textLimit)}…(${String(text.length - textLimit)} chars more)` : text
    out.push(`[${role}] ${body}`)
  }
  return out.slice(-Math.max(1, last))
}
