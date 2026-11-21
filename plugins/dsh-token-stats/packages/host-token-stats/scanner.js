/**
 * Read-only, incremental token-usage aggregator.
 *
 * WHAT IT READS
 * -------------
 * `/root/.dsh/sessions/<projectSlug>/<sessionId>/session.v4.jsonl.zstd` — the
 * authoritative append-only session log. `assistant/message` events carry the
 * provider-reported `data.usage` (disjoint buckets: uncached input, output,
 * cache read, cache write); `request/context` / `request/header` events carry
 * the model the next calls went to. Nothing is ever written, renamed or deleted.
 *
 * WHY NOT THE PROJECTION CACHE
 * ----------------------------
 * `~/.dsh/storages/session_projcache/sessions/*.json` already has per-session
 * totals (15 ms to parse all of them) but only ONE cumulative number per
 * session: it cannot answer "per day × per model". The daily breakdown only
 * exists in the event log, so this module aggregates the log itself.
 *
 * CACHING / INCREMENTAL READS
 * ---------------------------
 * Each session file is cached under `path → { mtimeMs, size, aggregate }`.
 * A refresh `stat()`s every file (76 files ≈ 1 ms) and only reads + parses the
 * files whose `mtime` or `size` changed; unchanged files are reused. When a
 * write happens to be caught mid-frame the previous good aggregate is kept, so
 * numbers never go down. The first (cold) scan parses everything once and is
 * reported separately from warm refreshes in `performance`.
 *
 * BILLED DEFINITION
 * -----------------
 * billed = uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
 * (provider values, not character-count estimates). Days are grouped by the
 * Asia/Shanghai calendar date (UTC+8, fixed since 1991 — no DST).
 *
 * @module host-token-stats/scanner
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** Asia/Shanghai is a fixed UTC+8 offset. */
export const TZ_OFFSET_MS = 8 * 60 * 60 * 1000

/** Human-readable zone label reported to the UI. */
export const TIME_ZONE = 'Asia/Shanghai (UTC+8, fixed)'

/** File name every session directory carries. */
const SESSION_FILE = 'session.v4.jsonl.zstd'

/** Bucket fields kept per day / per model. */
const BUCKETS = ['billed', 'uncachedInput', 'output', 'cacheRead', 'cacheWrite']

/** Monotonic milliseconds; falls back to `Date.now` on old runtimes. */
function now() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** One decimal place of milliseconds. */
function ms(value) {
  return Math.round(value * 10) / 10
}

/** A finite number or zero. */
function numberOr0(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Add to a Map<number> counter. */
function bump(map, key, delta) {
  map.set(key, (map.get(key) ?? 0) + delta)
}

/**
 * The Asia/Shanghai calendar date of an epoch-ms instant.
 * @param {number} epochMs - event `time`.
 * @returns {string} `YYYY-MM-DD`.
 */
export function dayKey(epochMs) {
  return new Date(epochMs + TZ_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * Render an epoch-ms instant as an offset ISO string in Asia/Shanghai.
 * @param {number} epochMs - instant.
 * @returns {string} e.g. `2026-11-19T23:48:14.000+08:00`.
 */
export function isoLocal(epochMs) {
  return new Date(epochMs + TZ_OFFSET_MS).toISOString().replace(/Z$/, '+08:00')
}

/** Zeroed day bucket with its own model map. */
function emptyDay() {
  return { billed: 0, uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, events: 0, models: new Map() }
}

/** Zeroed per-file aggregate. */
function emptyFileAggregate() {
  return { days: new Map(), usageEvents: 0, firstTime: null, lastTime: null }
}

/**
 * Aggregate one decompressed session log.
 *
 * Only three event types can change the answer, so every other (mostly huge
 * tool-result) line is skipped with a substring test before `JSON.parse`.
 *
 * @param {Buffer} buffer - raw `.jsonl.zstd` bytes.
 * @returns {ReturnType<typeof emptyFileAggregate>} per-day buckets and model split.
 */
export function parseSessionBytes(buffer) {
  const text = zstdDecompressSync(buffer).toString('utf8')
  const aggregate = emptyFileAggregate()
  let model = 'unknown'
  for (const line of text.split('\n')) {
    if (line === '') continue
    if (!line.includes('"assistant/message"') && !line.includes('"request/context"') && !line.includes('"request/header"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    const type = event.type
    const data = event.data
    if (type === 'request/context') {
      if (data !== null && typeof data === 'object' && typeof data.model === 'string' && data.model !== '') model = data.model.trim()
      continue
    }
    if (type === 'request/header') {
      const candidate = data !== null && typeof data === 'object' ? data.header?.config?.model : undefined
      if (typeof candidate === 'string' && candidate !== '') model = candidate.trim()
      continue
    }
    if (type !== 'assistant/message') continue
    const usage = data !== null && typeof data === 'object' ? data.usage : undefined
    if (usage === null || typeof usage !== 'object') continue
    const time = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : null
    if (time === null) continue
    const uncachedInput = numberOr0(usage.inputTokens)
    const output = numberOr0(usage.outputTokens)
    const cacheRead = numberOr0(usage.cacheReadTokens)
    const cacheWrite = numberOr0(usage.cacheWriteTokens)
    const billed = uncachedInput + output + cacheRead + cacheWrite
    if (billed <= 0) continue
    const key = dayKey(time)
    let day = aggregate.days.get(key)
    if (day === undefined) {
      day = emptyDay()
      aggregate.days.set(key, day)
    }
    day.billed += billed
    day.uncachedInput += uncachedInput
    day.output += output
    day.cacheRead += cacheRead
    day.cacheWrite += cacheWrite
    day.events += 1
    bump(day.models, model, billed)
    aggregate.usageEvents += 1
    if (aggregate.firstTime === null || time < aggregate.firstTime) aggregate.firstTime = time
    if (aggregate.lastTime === null || time > aggregate.lastTime) aggregate.lastTime = time
  }
  return aggregate
}

/**
 * Incremental store over `~/.dsh/sessions`.
 *
 * One instance per plugin; `document()` is the only public read.
 */
export class UsageStore {
  /** @type {string} */
  #root
  /** @type {{ info?: (message: string) => void, warn?: (message: string) => void } | undefined} */
  #logger
  /** Freshness window; a document younger than this is served without even stat()ing. */
  #ttlMs
  /** @type {Map<string, { mtimeMs: number, size: number, aggregate: ReturnType<typeof emptyFileAggregate>, failed: boolean }>} */
  #cache = new Map()
  /** @type {object | null} */
  #document = null
  /** @type {number} */
  #documentAt = 0
  /** @type {Promise<void> | null} */
  #inFlight = null
  /** @type {{ requests: number, scans: number, cacheHits: number, firstScanMs: number | null, lastScanMs: number | null, lastRefresh: object | null }} */
  #stats = { requests: 0, scans: 0, cacheHits: 0, firstScanMs: null, lastScanMs: null, lastRefresh: null }

  /**
   * @param {object} options - store options.
   * @param {string} options.root - sessions root, e.g. `<DSH home>/sessions`.
   * @param {object} [options.logger] - plugin logger (`info`/`warn`).
   * @param {number} [options.ttlMs] - freshness window for serving a cached document (default 4000).
   */
  constructor(options) {
    this.#root = options.root
    this.#logger = options.logger
    this.#ttlMs = typeof options.ttlMs === 'number' && options.ttlMs >= 0 ? options.ttlMs : 4000
  }

  /** Sessions root being read. */
  get root() {
    return this.#root
  }

  /**
   * Current usage document.
   *
   * @param {{ maxAgeMs?: number, force?: boolean }} [options] - freshness overrides;
   *   `force` skips every cache and re-stats the tree.
   * @returns {Promise<object>} summary document ready for JSON.
   */
  async document(options = {}) {
    this.#stats.requests += 1
    const maxAgeMs = options.force === true ? 0 : (options.maxAgeMs ?? this.#ttlMs)
    const age = Date.now() - this.#documentAt
    if (this.#document !== null && age <= maxAgeMs) {
      this.#stats.cacheHits += 1
      return this.#render(true, age)
    }
    if (this.#inFlight === null) {
      this.#inFlight = this.#refresh().finally(() => { this.#inFlight = null })
    }
    try {
      await this.#inFlight
    } catch (error) {
      this.#logger?.warn(`token-stats: refresh failed: ${error instanceof Error ? error.message : String(error)}`)
      if (this.#document === null) this.#merge()
    }
    return this.#render(false, 0)
  }

  /** List every session log with its size and mtime. Missing trees are empty, not an error. */
  async #listFiles() {
    const files = []
    let projects
    try {
      projects = await readdir(this.#root, { withFileTypes: true })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return files
      throw error
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = join(this.#root, project.name)
      let sessions
      try {
        sessions = await readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const path = join(projectDir, session.name, SESSION_FILE)
        try {
          const info = await stat(path)
          files.push({ path, mtimeMs: info.mtimeMs, size: info.size })
        } catch {
          // Session directory without a log yet (or removed): nothing to count.
        }
      }
    }
    return files
  }

  /** Re-stat the tree, re-parse only changed files, then re-merge the cache. */
  async #refresh() {
    const started = now()
    const files = await this.#listFiles()
    const statMs = now() - started
    let reparsed = 0
    let reused = 0
    let failed = 0
    let parseMs = 0
    const seen = new Set()
    for (const file of files) {
      seen.add(file.path)
      const cached = this.#cache.get(file.path)
      if (cached !== undefined && cached.failed !== true && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        reused += 1
        continue
      }
      const parseStarted = now()
      try {
        const aggregate = parseSessionBytes(await readFile(file.path))
        this.#cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, aggregate, failed: false })
        reparsed += 1
      } catch (error) {
        failed += 1
        if (cached !== undefined && cached.failed !== true) {
          // Caught mid-append (incomplete zstd frame): keep the last good aggregate and retry next refresh.
          this.#cache.set(file.path, { ...cached, mtimeMs: file.mtimeMs, size: file.size })
          this.#logger?.warn(`token-stats: keeping previous aggregate for ${file.path} (${error instanceof Error ? error.message : String(error)})`)
        } else {
          this.#cache.set(file.path, { mtimeMs: file.mtimeMs, size: file.size, aggregate: emptyFileAggregate(), failed: true })
        }
      }
      parseMs += now() - parseStarted
    }
    for (const path of this.#cache.keys()) {
      if (!seen.has(path)) this.#cache.delete(path)
    }
    this.#merge()
    const totalMs = now() - started
    this.#stats.scans += 1
    this.#stats.lastScanMs = ms(totalMs)
    if (this.#stats.firstScanMs === null) this.#stats.firstScanMs = ms(totalMs)
    this.#stats.lastRefresh = {
      files: files.length,
      reparsed,
      reused,
      failed,
      statMs: ms(statMs),
      parseMs: ms(parseMs),
      totalMs: ms(totalMs),
    }
    if (reparsed > 0 || this.#stats.scans === 1) {
      this.#logger?.info(`token-stats: scanned ${files.length} session files (re-parsed ${reparsed}, reused ${reused}) in ${ms(totalMs)}ms`)
    }
  }

  /** Fold every cached per-file aggregate into one document. */
  #merge() {
    /** @type {Map<string, ReturnType<typeof emptyDay>>} */
    const days = new Map()
    /** @type {Map<string, number>} */
    const modelTotals = new Map()
    const totals = { billed: 0, uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    let usageEvents = 0
    let firstTime = null
    let lastTime = null
    let failedFiles = 0
    for (const entry of this.#cache.values()) {
      const aggregate = entry.aggregate
      if (entry.failed === true) failedFiles += 1
      usageEvents += aggregate.usageEvents
      for (const [key, source] of aggregate.days) {
        let target = days.get(key)
        if (target === undefined) {
          target = emptyDay()
          days.set(key, target)
        }
        for (const bucket of BUCKETS) target[bucket] += source[bucket]
        target.events += source.events
        for (const [model, tokens] of source.models) {
          bump(target.models, model, tokens)
          bump(modelTotals, model, tokens)
        }
      }
      if (aggregate.firstTime !== null && (firstTime === null || aggregate.firstTime < firstTime)) firstTime = aggregate.firstTime
      if (aggregate.lastTime !== null && (lastTime === null || aggregate.lastTime > lastTime)) lastTime = aggregate.lastTime
    }
    for (const day of days.values()) {
      for (const bucket of BUCKETS) totals[bucket] += day[bucket]
    }
    this.#document = {
      days,
      modelTotals,
      totals,
      usageEvents,
      firstTime,
      lastTime,
      files: this.#cache.size,
      failedFiles,
    }
    this.#documentAt = Date.now()
  }

  /**
   * Serialize the merged state for the UI.
   * @param {boolean} servedFromCache - whether this call avoided a refresh.
   * @param {number} cacheAgeMs - age of the cached merge.
   * @returns {object} JSON-safe document.
   */
  #render(servedFromCache, cacheAgeMs) {
    const at = Date.now()
    const merged = this.#document
    const days = []
    const dates = merged === null ? [] : [...merged.days.keys()].sort()
    const todayDate = dayKey(at)
    let today = emptyDay()
    for (const date of dates) {
      const day = merged.days.get(date)
      if (date === todayDate) today = day
      const models = {}
      for (const [model, tokens] of [...day.models.entries()].sort((left, right) => right[1] - left[1])) models[model] = tokens
      days.push({ date, ...pickBuckets(day), events: day.events, models })
    }
    const models = []
    if (merged !== null) {
      for (const [model, total] of [...merged.modelTotals.entries()].sort((left, right) => right[1] - left[1])) {
        const todayTokens = today.models.get(model) ?? 0
        models.push({
          model,
          total,
          today: todayTokens,
          share: today.billed > 0 ? todayTokens / today.billed : 0,
        })
      }
    }
    return {
      generatedAt: isoLocal(at),
      generatedAtMs: at,
      timeZone: TIME_ZONE,
      timeZoneOffset: '+08:00',
      source: {
        sessionsDir: this.#root,
        sessionFiles: merged?.files ?? 0,
        sessionFilesFailed: merged?.failedFiles ?? 0,
        usageEvents: merged?.usageEvents ?? 0,
        firstUsageAt: merged?.firstTime == null ? null : isoLocal(merged.firstTime),
        lastUsageAt: merged?.lastTime == null ? null : isoLocal(merged.lastTime),
      },
      totals: merged === null ? { billed: 0, uncachedInput: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : { ...merged.totals },
      today: { date: todayDate, ...pickBuckets(today), events: today.events },
      models,
      days,
      billing: {
        formula: 'billed = uncachedInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens',
        includesCacheReads: true,
        source: 'provider-reported assistant/message usage',
      },
      performance: {
        requests: this.#stats.requests,
        scans: this.#stats.scans,
        cacheHits: this.#stats.cacheHits,
        firstScanMs: this.#stats.firstScanMs,
        lastScanMs: this.#stats.lastScanMs,
        servedFromCache,
        cacheAgeMs,
        lastRefresh: this.#stats.lastRefresh,
      },
    }
  }
}

/** Copy the five bucket fields out of a day aggregate. */
function pickBuckets(day) {
  return {
    billed: day.billed,
    uncachedInput: day.uncachedInput,
    output: day.output,
    cacheRead: day.cacheRead,
    cacheWrite: day.cacheWrite,
  }
}
