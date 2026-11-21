/**
 * The exit store: exits, bindings, the default exit and last probe results.
 *
 * One JSON file (`config.json`, mode 0600, in a 0700 directory) holds
 * everything, proxy credentials included. The file is the source of truth and
 * the in-memory copy is reloaded whenever its mtime or size changes, so a hand
 * edit takes effect on the next request without a restart.
 *
 * A file that exists but cannot be parsed or validated is reported as
 * `corrupt`, and the request hook treats that as "block every non-loopback
 * request": an unreadable policy must never degrade into "connect directly".
 *
 * @module host-egress/store
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  DIRECT_ID, ValidationError, validateCredential, validateHost, validateId, validateName, validatePort, validateType,
} from './validate.ts'
import type { ProxyType } from './validate.ts'

/** Credentials of one proxy. */
export interface ExitAuth {
  readonly username: string
  readonly password: string
}

/** One user-defined exit as stored. */
export interface StoredExit {
  readonly id: string
  readonly name: string
  readonly type: ProxyType
  readonly host: string
  readonly port: number
  readonly auth?: ExitAuth
  readonly createdAt: string
}

/** The last probe of one exit. */
export interface ProbeRecord {
  readonly ok: boolean
  readonly ip?: string
  readonly ms?: number
  readonly error?: string
  readonly at: string
}

/** The whole persisted document. */
export interface StoredConfig {
  readonly version: 1
  readonly exits: readonly StoredExit[]
  /** Host (lower-case, no port) → exit id. `*` is never stored here; see `defaultExit`. */
  readonly bindings: Readonly<Record<string, string>>
  /** Exit for hosts without a binding. Starts as `direct`. */
  readonly defaultExit: string
  readonly probes: Readonly<Record<string, ProbeRecord>>
}

/** A fresh document: no exits, everything direct. */
export const EMPTY_CONFIG: StoredConfig = Object.freeze({
  version: 1, exits: [], bindings: {}, defaultExit: DIRECT_ID, probes: {},
})

/** What `snapshot()` returns. */
export interface StoreSnapshot {
  readonly config: StoredConfig
  /** Set when the file exists but is unusable. */
  readonly corrupt?: string
}

/**
 * Validate a decoded document, rebuilding it from validated parts.
 * @param raw - parsed JSON.
 * @returns the clean document.
 * @throws {ValidationError} when anything is off.
 */
export function parseConfig(raw: unknown): StoredConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ValidationError('corrupt', 'config root must be an object')
  const doc = raw as Record<string, unknown>
  if (doc['version'] !== 1) throw new ValidationError('corrupt', 'unsupported config version')
  if (!Array.isArray(doc['exits'])) throw new ValidationError('corrupt', 'exits must be an array')
  const seen = new Set<string>()
  const exits: StoredExit[] = doc['exits'].map((entry: unknown) => {
    const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>
    const id = validateId(row['id'])
    if (seen.has(id)) throw new ValidationError('corrupt', `duplicate exit id ${id}`)
    seen.add(id)
    const auth = row['auth']
    let parsedAuth: ExitAuth | undefined
    if (auth !== undefined && auth !== null) {
      const a = auth as Record<string, unknown>
      parsedAuth = { username: validateCredential(a['username'], 'username'), password: validateCredential(a['password'], 'password') }
    }
    return {
      id,
      name: validateName(row['name']),
      type: validateType(row['type']),
      host: validateHost(row['host']),
      port: validatePort(row['port']),
      ...parsedAuth === undefined ? {} : { auth: parsedAuth },
      createdAt: typeof row['createdAt'] === 'string' ? row['createdAt'] : new Date(0).toISOString(),
    }
  })
  const bindings: Record<string, string> = {}
  const rawBindings = doc['bindings']
  if (typeof rawBindings === 'object' && rawBindings !== null && !Array.isArray(rawBindings)) {
    for (const [host, exit] of Object.entries(rawBindings)) {
      if (typeof exit !== 'string') throw new ValidationError('corrupt', 'binding target must be a string')
      bindings[validateHost(host)] = exit
    }
  }
  const defaultExit = typeof doc['defaultExit'] === 'string' ? doc['defaultExit'] : DIRECT_ID
  const probes: Record<string, ProbeRecord> = {}
  const rawProbes = doc['probes']
  if (typeof rawProbes === 'object' && rawProbes !== null && !Array.isArray(rawProbes)) {
    for (const [id, value] of Object.entries(rawProbes)) {
      const p = value as Record<string, unknown>
      if (typeof p !== 'object' || p === null || typeof p['ok'] !== 'boolean') continue
      probes[id] = {
        ok: p['ok'],
        at: typeof p['at'] === 'string' ? p['at'] : new Date(0).toISOString(),
        ...typeof p['ip'] === 'string' ? { ip: p['ip'] } : {},
        ...typeof p['ms'] === 'number' ? { ms: p['ms'] } : {},
        ...typeof p['error'] === 'string' ? { error: p['error'].slice(0, 200) } : {},
      }
    }
  }
  return { version: 1, exits, bindings, defaultExit, probes }
}

/** Mutable working copy handed to `mutate`. */
export interface Draft {
  exits: StoredExit[]
  bindings: Record<string, string>
  defaultExit: string
  probes: Record<string, ProbeRecord>
}

/** File-backed store. */
export class EgressStore {
  private cached: StoreSnapshot = { config: EMPTY_CONFIG }
  private stamp = ''
  private queue: Promise<unknown> = Promise.resolve()

  /** @param dir - data directory; created 0700 on the first write. */
  constructor(readonly dir: string) {}

  /** Absolute path of the document. */
  get file(): string { return join(this.dir, 'config.json') }

  /**
   * Current state, reloading when the file changed on disk.
   * @returns the config, or `corrupt` when the file is unusable.
   */
  snapshot(): StoreSnapshot {
    let stamp = 'missing'
    try {
      const info = statSync(this.file)
      stamp = `${String(info.mtimeMs)}:${String(info.size)}`
    } catch {
      stamp = 'missing'
    }
    if (stamp === this.stamp) return this.cached
    this.stamp = stamp
    if (stamp === 'missing') {
      this.cached = { config: EMPTY_CONFIG }
      return this.cached
    }
    try {
      this.cached = { config: parseConfig(JSON.parse(readFileSync(this.file, 'utf8'))) }
    } catch (error) {
      this.cached = { config: EMPTY_CONFIG, corrupt: error instanceof Error ? error.message : String(error) }
    }
    return this.cached
  }

  /**
   * Apply one change and persist it atomically.
   *
   * Changes are serialised. A corrupt file is moved aside to
   * `config.json.corrupt-<time>` before the first write over it.
   * @param change - edits the draft; may throw {@link ValidationError} to abort.
   * @returns the new config.
   */
  mutate(change: (draft: Draft) => void): Promise<StoredConfig> {
    const run = async (): Promise<StoredConfig> => {
      const current = this.snapshot()
      const draft: Draft = {
        exits: [...current.config.exits],
        bindings: { ...current.config.bindings },
        defaultExit: current.config.defaultExit,
        probes: { ...current.config.probes },
      }
      change(draft)
      const next: StoredConfig = parseConfig({ version: 1, ...draft })
      await this.write(next, current.corrupt !== undefined)
      this.snapshot()
      return next
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => undefined)
    return result
  }

  /** Write the document: tmp file, then rename with a retry for Windows EPERM/EBUSY. */
  private async write(config: StoredConfig, moveCorruptAside: boolean): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try { await chmod(this.dir, 0o700) } catch { /* not supported on this platform */ }
    if (moveCorruptAside && existsSync(this.file)) {
      await rename(this.file, `${this.file}.corrupt-${String(Date.now())}`)
    }
    const temp = `${this.file}.tmp-${String(process.pid)}-${String(Date.now())}`
    await writeFile(temp, `${JSON.stringify(config, undefined, 2)}\n`, { mode: 0o600 })
    try { chmodSync(temp, 0o600) } catch { /* not supported on this platform */ }
    let lastError: unknown
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await rename(temp, this.file)
        return
      } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
        await new Promise(done => setTimeout(done, 25 * 2 ** attempt))
      }
    }
    await rm(temp, { force: true })
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** Create the directory with the right mode (idempotent). */
  ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    try { chmodSync(this.dir, 0o700) } catch { /* not supported on this platform */ }
  }
}