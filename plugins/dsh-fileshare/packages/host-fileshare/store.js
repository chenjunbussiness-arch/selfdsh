/**
 * Link store: one JSON file (`<DSH home>/fileshare/links.json`, mode 600),
 * written atomically, every change serialized through one queue.
 *
 * A link record never holds its token: only `tokenHash` (sha256, hex). The
 * full URL exists once, in the answer to the call that created it.
 *
 * Several DSH processes can share one DSH home (the web service, a headless
 * run, another profile), so the file is the source of truth: reads reload it
 * when it changed on disk, and every change takes a lock file
 * (`links.json.lock`, created exclusively) and re-reads the file before it
 * writes. A lock older than 10 seconds is treated as left over and removed.
 *
 * @module dsh-host-fileshare/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STATE_VERSION = 1
/** Length of a token in base64url characters (24 random bytes). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function newToken() {
  return randomBytes(24).toString('base64url')
}

const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function signature(info) {
  return info === undefined ? 'none' : `${info.ino}:${info.size}:${info.mtimeMs}`
}

async function statOrUndefined(file) {
  try { return await stat(file) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function newId() {
  return randomBytes(5).toString('hex')
}

/** Link state at `now`: active, expired, revoked or used-up. */
export function linkState(link, now = Date.now()) {
  if (link.revokedAt !== undefined) return 'revoked'
  if (Date.parse(link.expiresAt) <= now) return 'expired'
  if (link.kind === 'download' && link.maxDownloads !== null && link.downloads >= link.maxDownloads) return 'used-up'
  if (link.kind === 'upload' && (link.files.length >= link.maxFiles || link.receivedBytes >= link.maxBytes)) return 'used-up'
  return 'active'
}

export class LinkStore {
  /**
   * @param {{ file: string, maxActiveLinks: number, keepExpiredMs: number, clock?: () => number }} options
   */
  constructor({ file, maxActiveLinks, keepExpiredMs, clock = Date.now }) {
    this.file = file
    this.maxActiveLinks = maxActiveLinks
    this.keepExpiredMs = keepExpiredMs
    this.clock = clock
    this.state = undefined
    this.signature = undefined
    this.queue = Promise.resolve()
  }

  /** The current state; re-read when the file changed since the last read or write. */
  async load() {
    const info = await statOrUndefined(this.file)
    if (this.state !== undefined && signature(info) === this.signature) return this.state
    let parsed
    try {
      parsed = info === undefined ? undefined : JSON.parse(await readFile(this.file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`dsh-fileshare: cannot read ${this.file}: ${error.message}`)
      parsed = undefined
    }
    this.signature = signature(info)
    const links = Array.isArray(parsed?.links) ? parsed.links.filter(link => typeof link?.tokenHash === 'string' && typeof link?.id === 'string') : []
    this.state = {
      version: STATE_VERSION,
      origin: typeof parsed?.origin?.base === 'string' ? parsed.origin : undefined,
      workspaces: Array.isArray(parsed?.workspaces) ? parsed.workspaces.filter(item => typeof item === 'string').slice(0, 20) : [],
      links,
    }
    return this.state
  }

  /** Run `change(state)` under the queue and persist. */
  update(change) {
    const run = this.queue.then(async () => {
      const release = await this.lock()
      try {
        const state = await this.load()
        const result = await change(state)
        this.prune(state)
        await this.save(state)
        return result
      } catch (error) {
        this.state = undefined
        throw error
      } finally {
        await release()
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  prune(state) {
    const now = this.clock()
    state.links = state.links.filter((link) => {
      if (linkState(link, now) === 'active') return true
      const ended = link.revokedAt ?? link.expiresAt
      return now - Date.parse(ended) < this.keepExpiredMs
    })
  }

  /** Take the cross-process lock; resolves to its release function. */
  async lock() {
    const lockFile = `${this.file}.lock`
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const started = Date.now()
    for (;;) {
      try {
        const handle = await open(lockFile, 'wx', 0o600)
        await handle.writeFile(`${process.pid}\n`)
        await handle.close()
        return async () => { await rm(lockFile, { force: true }) }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
      const info = await statOrUndefined(lockFile)
      if (info !== undefined && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(lockFile, { force: true })
        continue
      }
      if (Date.now() - started > LOCK_WAIT_MS) throw new Error(`dsh-fileshare: ${lockFile} is held by another process`)
      await sleep(15 + Math.random() * 25)
    }
  }

  async save(state) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.tmp-${process.pid}-${newId()}`
    await writeFile(temp, `${JSON.stringify(state, undefined, 2)}\n`, { mode: 0o600 })
    await rename(temp, this.file)
    try { await chmod(this.file, 0o600) } catch { /* best effort on Windows */ }
    this.state = state
    this.signature = signature(await statOrUndefined(this.file))
  }

  /**
   * Create a link. Returns the record and its token (the only time the token exists).
   * @param {Record<string, unknown>} fields
   */
  async create(fields) {
    return this.update((state) => {
      const now = this.clock()
      const active = state.links.filter(link => linkState(link, now) === 'active').length
      if (active >= this.maxActiveLinks) throw new Error(`too many active links (${active}); revoke some first`)
      const token = newToken()
      const link = {
        id: newId(),
        tokenHash: hashToken(token),
        createdAt: new Date(now).toISOString(),
        ...fields,
      }
      if (link.kind === 'download') { link.downloads = 0; link.bytesSent = 0 }
      if (link.kind === 'upload') { link.files = []; link.receivedBytes = 0 }
      state.links.push(link)
      return { link: structuredClone(link), token }
    })
  }

  /** The record for a token, or undefined (read-only snapshot). */
  async find(token) {
    if (!TOKEN_RE.test(token)) return undefined
    const state = await this.load()
    const hash = hashToken(token)
    const link = state.links.find(item => item.tokenHash === hash)
    return link === undefined ? undefined : structuredClone(link)
  }

  /** Apply `change(link)` to the record with this id under the queue. */
  async mutate(id, change) {
    return this.update((state) => {
      const link = state.links.find(item => item.id === id)
      if (link === undefined) return undefined
      const result = change(link)
      return result === undefined ? structuredClone(link) : result
    })
  }

  async revoke(id) {
    return this.mutate(id, (link) => {
      if (link.revokedAt === undefined) link.revokedAt = new Date(this.clock()).toISOString()
      return undefined
    })
  }

  async list() {
    const state = await this.load()
    this.prune(state)
    return structuredClone(state.links)
  }

  async origin() {
    return (await this.load()).origin
  }

  async setOrigin(base) {
    const current = await this.origin()
    if (current?.base === base && this.clock() - Date.parse(current.seenAt) < 60 * 60 * 1000) return
    await this.update((state) => { state.origin = { base, seenAt: new Date(this.clock()).toISOString() } })
  }

  async workspaces() {
    return [...(await this.load()).workspaces]
  }

  async noteWorkspace(dir) {
    const state = await this.load()
    if (state.workspaces[0] === dir) return
    await this.update((next) => {
      next.workspaces = [dir, ...next.workspaces.filter(item => item !== dir)].slice(0, 20)
    })
  }
}
