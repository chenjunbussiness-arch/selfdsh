/**
 * The operations behind both the agent tools and the page: create a download
 * link, create an upload link, list, revoke. Every path check lives in
 * paths.js; every link is stored by store.js; the public base comes from
 * origin.js rules.
 *
 * @module dsh-host-fileshare/service
 */

import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { effectiveRoots, deniedBy, isInside, resolveShareable, resolveUploadDir } from './paths.js'
import { linkState } from './store.js'

export const ROUTE_BASE = '/api/fileshare'
export const DOWNLOAD_BASE = `${ROUTE_BASE}/d`
export const UPLOAD_BASE = `${ROUTE_BASE}/u`

const MIB = 1024 * 1024
const HUB_TASK_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

/** A caller-facing error (message is safe to show). */
export class ShareError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'ShareError'
    this.status = status
  }
}

function minutes(raw, fallback, max, key) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) throw new ShareError(`${key} must be a positive number of minutes`)
  return Math.min(Math.ceil(raw), max)
}

function optionalCount(raw, key, max = 100000) {
  if (raw === undefined || raw === null) return null
  if (!Number.isInteger(raw) || raw < 1 || raw > max) throw new ShareError(`${key} must be an integer between 1 and ${max}`)
  return raw
}

function note(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw new ShareError('note must be a string')
  return raw.trim().slice(0, 200) || undefined
}

/** Human size. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function createService({ config, store, logger }) {
  const log = (message) => { try { logger?.info?.(message) } catch { /* ignore */ } }

  /** The base URL links are built on, or undefined with the reason. */
  async function publicBase() {
    if (config.publicBaseUrl !== '') return { base: config.publicBaseUrl, source: 'config' }
    const seen = await store.origin()
    if (seen?.base !== undefined) return { base: seen.base, source: 'browser' }
    return { base: undefined, source: 'none' }
  }

  function linkUrl(base, kind, token, name) {
    const path = kind === 'download'
      ? `${DOWNLOAD_BASE}/${token}/${encodeURIComponent(name)}`
      : `${UPLOAD_BASE}/${token}/`
    return { path, url: base === undefined ? null : `${base}${path}` }
  }

  async function roots(cwd) {
    const extra = []
    if (config.includeSessionCwd && typeof cwd === 'string' && cwd !== '') extra.push(cwd)
    const recent = await store.workspaces()
    return effectiveRoots(config, [...extra, ...(cwd === undefined ? recent : [])])
  }

  /** Remember a session cwd so the page can offer it later (only usable ones). */
  async function noteWorkspace(cwd) {
    if (!config.includeSessionCwd || typeof cwd !== 'string' || cwd === '') return
    const { roots: usable } = await effectiveRoots(config, [cwd])
    let real
    try { real = await realpath(cwd) } catch { return }
    if (usable.includes(real)) await store.noteWorkspace(real).catch(() => undefined)
  }

  async function resolveHubOutput(task, name) {
    if (typeof task !== 'string' || !HUB_TASK_RE.test(task)) throw new ShareError('hub_task is not a valid task id')
    if (typeof name !== 'string' || name === '' || /[\\/]/.test(name) || name === '.' || name === '..') throw new ShareError('name must be one output file name of that task')
    const outputs = join(config.hubArtifactsDir, task, 'outputs')
    let realOutputs
    let real
    try {
      realOutputs = await realpath(outputs)
      real = await realpath(join(outputs, name))
    } catch {
      throw new ShareError('that task has no such output file', 404)
    }
    if (!isInside(realOutputs, real) || real === realOutputs) throw new ShareError('that task has no such output file', 404)
    const pattern = deniedBy(name, config.deny)
    if (pattern !== undefined) throw new ShareError(`name matches deny pattern ${pattern}`, 403)
    const info = await stat(real)
    if (!info.isFile()) throw new ShareError('not a regular file')
    return { real, size: info.size, root: realOutputs, rel: name }
  }

  /**
   * Create a download link.
   * @param {{ path?: string, hubTask?: string, name?: string, cwd?: string, ttlMinutes?: number, maxDownloads?: number, note?: string, by: string }} input
   */
  async function createDownload(input) {
    let target
    if (input.hubTask !== undefined) {
      target = await resolveHubOutput(input.hubTask, input.name)
    } else {
      const { roots: allowed } = await roots(input.cwd)
      const found = await resolveShareable(input.path, { cwd: input.cwd, roots: allowed, deny: config.deny })
      if (!found.ok) throw new ShareError(`cannot share ${String(input.path)}: ${found.reason}`, found.reason === 'file not found' ? 404 : 403)
      target = found
    }
    const ttl = minutes(input.ttlMinutes, config.downloadTtlMinutes, config.downloadMaxTtlMinutes, 'ttl_minutes')
    const fileName = basename(target.real)
    const { link, token } = await store.create({
      kind: 'download',
      path: target.real,
      root: target.root,
      name: fileName,
      size: target.size,
      expiresAt: new Date(Date.now() + ttl * 60000).toISOString(),
      maxDownloads: optionalCount(input.maxDownloads, 'max_downloads'),
      note: note(input.note),
      by: input.by,
    })
    log(`dsh-fileshare: download link ${link.id} for ${fileName} (${formatBytes(target.size)}), ${ttl} min, by ${input.by}`)
    const { base, source } = await publicBase()
    return { ...view(link), ...linkUrl(base, 'download', token, fileName), baseSource: source }
  }

  /**
   * Create an upload link.
   * @param {{ dir?: string, cwd?: string, ttlMinutes?: number, maxFiles?: number, maxMb?: number, note?: string, by: string }} input
   */
  async function createUpload(input) {
    const { roots: allowed } = await roots(input.cwd)
    const wanted = input.dir === undefined || input.dir === null || input.dir === '' ? config.inboxDir : input.dir
    if (wanted === config.inboxDir) {
      await mkdir(config.inboxDir, { recursive: true, mode: 0o700 })
      const real = await realpath(config.inboxDir)
      if (!allowed.includes(real)) allowed.push(real)
    }
    const found = await resolveUploadDir(wanted, { cwd: input.cwd, roots: allowed, deny: config.deny })
    if (!found.ok) throw new ShareError(`cannot receive into ${String(wanted)}: ${found.reason}`, 403)
    const ttl = minutes(input.ttlMinutes, config.uploadTtlMinutes, config.uploadMaxTtlMinutes, 'ttl_minutes')
    const maxFiles = optionalCount(input.maxFiles, 'max_files', 1000) ?? config.uploadMaxFiles
    let maxBytes = config.uploadMaxBytes
    if (input.maxMb !== undefined && input.maxMb !== null) {
      if (typeof input.maxMb !== 'number' || !Number.isFinite(input.maxMb) || input.maxMb <= 0) throw new ShareError('max_mb must be a positive number')
      maxBytes = Math.min(Math.ceil(input.maxMb * MIB), config.uploadMaxBytesCap)
    }
    const { link, token } = await store.create({
      kind: 'upload',
      path: found.dir,
      root: found.root,
      name: basename(found.dir),
      expiresAt: new Date(Date.now() + ttl * 60000).toISOString(),
      maxFiles,
      maxBytes,
      note: note(input.note),
      by: input.by,
    })
    log(`dsh-fileshare: upload link ${link.id} into ${basename(found.dir)}, ${ttl} min, ${maxFiles} files / ${formatBytes(maxBytes)}, by ${input.by}`)
    const { base, source } = await publicBase()
    return { ...view(link), ...linkUrl(base, 'upload', token), baseSource: source }
  }

  async function list({ id, activeOnly = false } = {}) {
    const now = Date.now()
    const links = (await store.list())
      .filter(link => id === undefined || link.id === id)
      .map(link => view(link, now))
      .filter(link => !activeOnly || link.state === 'active')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return links
  }

  async function revoke(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{10}$/.test(id)) throw new ShareError('id must be a link id')
    const link = await store.revoke(id)
    if (link === undefined) throw new ShareError(`no link ${id}`, 404)
    log(`dsh-fileshare: link ${id} revoked`)
    return view(link)
  }

  return { publicBase, createDownload, createUpload, list, revoke, roots, noteWorkspace }
}

/** The record as shown to tools and the page: no token, no hash. */
export function view(link, now = Date.now()) {
  const out = {
    id: link.id,
    kind: link.kind,
    state: linkState(link, now),
    name: link.name,
    path: link.path,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    by: link.by,
  }
  if (link.note !== undefined) out.note = link.note
  if (link.revokedAt !== undefined) out.revokedAt = link.revokedAt
  if (link.kind === 'download') {
    out.size = link.size
    out.downloads = link.downloads
    out.maxDownloads = link.maxDownloads
    if (link.lastAccessAt !== undefined) out.lastAccessAt = link.lastAccessAt
  } else {
    out.maxFiles = link.maxFiles
    out.maxBytes = link.maxBytes
    out.receivedBytes = link.receivedBytes
    out.files = link.files.map(file => ({ name: file.name, size: file.size, sha256: file.sha256, at: file.at }))
  }
  return out
}
