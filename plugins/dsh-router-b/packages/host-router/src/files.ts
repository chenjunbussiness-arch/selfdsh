/**
 * Workspace view of the partitions: what files each partition holds, and
 * whether the partition configuration itself has problems.
 *
 * The panel's 工作区 page reads one directory level per request
 * (`GET /api/router/files?partition=&path=`), so a large tree costs nothing
 * until someone opens it. Every entry says whether the partition's
 * include/exclude globs put it in scope, which is the same rule a worker's
 * brief tells it to respect.
 *
 * Safety: the path is relative to the partition root, may not climb out of it
 * (`..`, absolute paths, or a symlink that resolves elsewhere), and only names,
 * kinds, sizes and times are returned — never file contents.
 *
 * @module host-router/files
 */

import { readdir, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { containsFile, globToRegExp, relativeUnder, toPosix } from './config.ts'
import type { Partition } from './config.ts'

/** Names never listed: VCS internals and dependency trees are noise here. */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db'])

/** Most entries one listing returns; the rest are counted, not sent. */
export const MAX_ENTRIES = 500

/** One file or directory in a listing. */
export interface FileEntry {
  readonly name: string
  /** Path relative to the partition root, `/`-separated. */
  readonly path: string
  readonly kind: 'dir' | 'file' | 'link'
  readonly size?: number
  readonly modifiedAt?: string
  /**
   * Whether the partition's globs put it in scope. For a directory: false only
   * when an exclude glob removes the whole directory.
   */
  readonly inScope: boolean
}

/** One directory level of one partition. */
export interface FileListing {
  readonly partition: string
  readonly root: string
  /** The listed directory, relative to the root (`''` for the root). */
  readonly path: string
  readonly entries: readonly FileEntry[]
  /** Entries left out past {@link MAX_ENTRIES}. */
  readonly omitted: number
  readonly include: readonly string[]
  readonly exclude: readonly string[]
}

/** A request the listing refuses, with the HTTP status that fits it. */
export class FileListError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'FileListError'
  }
}

/**
 * Normalise a requested relative path, refusing anything that could leave the root.
 * @returns the `/`-separated relative path, `''` for the root.
 */
export function safeRelative(raw: string | undefined): string {
  const text = toPosix((raw ?? '').trim()).replace(/^\.\/+/, '').replace(/\/+$/, '')
  if (text === '' || text === '.') return ''
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text) || text.includes('\0')) {
    throw new FileListError(400, 'bad-request', 'path must be relative to the partition root')
  }
  const parts = text.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) throw new FileListError(400, 'bad-request', 'path may not contain ".."')
  if (parts.some(part => HIDDEN_NAMES.has(part))) throw new FileListError(403, 'forbidden', 'that directory is not listed')
  return parts.join('/')
}

/**
 * Whether a directory is removed from scope as a whole by an exclude glob:
 * true when every path below it would be excluded (`vendor/**`, `**`), not
 * when only some files are (an extension glob such as one for log files).
 */
function dirExcluded(partition: Partition, relative: string): boolean {
  const probes = [`${relative}/__dsh_probe__`, `${relative}/__dsh_probe__/__dsh_probe__.x`]
  return (partition.exclude ?? []).some((pattern) => {
    const regex = globToRegExp(pattern)
    return probes.every(probe => regex.test(probe))
  })
}

/**
 * List one directory level of one partition.
 * @param partition - the normalised partition.
 * @param rawPath - directory relative to the partition root.
 */
export async function listPartitionDir(partition: Partition, rawPath: string | undefined): Promise<FileListing> {
  const relative = safeRelative(rawPath)
  let rootReal: string
  try {
    rootReal = await realpath(partition.dir)
  } catch {
    throw new FileListError(404, 'not-found', `partition root ${partition.dir} does not exist`)
  }
  const target = relative === '' ? partition.dir : join(partition.dir, ...relative.split('/'))
  let targetReal: string
  try {
    targetReal = await realpath(target)
  } catch {
    throw new FileListError(404, 'not-found', `${relative || '.'} does not exist in partition "${partition.name}"`)
  }
  // A symlink inside the partition must not become a window onto the rest of the disk.
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`)) {
    throw new FileListError(403, 'forbidden', `${relative} resolves outside the partition root`)
  }
  const info = await stat(targetReal)
  if (!info.isDirectory()) throw new FileListError(400, 'bad-request', `${relative} is not a directory`)

  const dirents = await readdir(targetReal, { withFileTypes: true })
  const visible = dirents.filter(entry => !HIDDEN_NAMES.has(entry.name))
  visible.sort((left, right) => {
    const ld = left.isDirectory() ? 0 : 1
    const rd = right.isDirectory() ? 0 : 1
    if (ld !== rd) return ld - rd
    return left.name.localeCompare(right.name)
  })
  const kept = visible.slice(0, MAX_ENTRIES)
  const entries: FileEntry[] = []
  for (const entry of kept) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    const absolute = join(target, entry.name)
    const kind: FileEntry['kind'] = entry.isDirectory() ? 'dir' : entry.isSymbolicLink() ? 'link' : 'file'
    let size: number | undefined
    let modifiedAt: string | undefined
    try {
      const meta = await stat(absolute)
      if (kind !== 'dir') size = meta.size
      modifiedAt = meta.mtime.toISOString()
    } catch {
      // A dangling link or a file removed mid-listing: list the name, no metadata.
    }
    entries.push({
      name: entry.name,
      path,
      kind,
      ...size === undefined ? {} : { size },
      ...modifiedAt === undefined ? {} : { modifiedAt },
      inScope: kind === 'dir' ? !dirExcluded(partition, path) : containsFile(partition, absolute),
    })
  }
  return {
    partition: partition.name,
    root: partition.dir,
    path: relative,
    entries,
    omitted: visible.length - kept.length,
    include: partition.include ?? ['**'],
    exclude: partition.exclude ?? [],
  }
}

/** One configuration problem a person should fix. */
export interface PartitionProblem {
  readonly partition: string
  readonly level: 'error' | 'warning'
  readonly message: string
}

/**
 * Check the partition layout once at boot: missing roots, roots that are not
 * directories, and roots nested inside each other (allowed — the deeper root
 * wins a file — but worth seeing, because two managers then share files).
 */
export async function partitionProblems(partitions: readonly Partition[]): Promise<readonly PartitionProblem[]> {
  const problems: PartitionProblem[] = []
  for (const partition of partitions) {
    try {
      const info = await stat(partition.dir)
      if (!info.isDirectory()) {
        problems.push({ partition: partition.name, level: 'error', message: `根目录 ${partition.dir} 不是目录` })
      }
    } catch {
      problems.push({ partition: partition.name, level: 'error', message: `根目录 ${partition.dir} 不存在` })
    }
    if (partition.include !== undefined && partition.include.length === 0) {
      problems.push({ partition: partition.name, level: 'warning', message: 'include 为空：这个分区不包含任何文件' })
    }
    if ((partition.exclude ?? []).some(pattern => pattern === '**' || pattern === '**/*')) {
      problems.push({ partition: partition.name, level: 'warning', message: 'exclude 排除了全部文件' })
    }
  }
  for (const outer of partitions) {
    for (const inner of partitions) {
      if (outer === inner) continue
      const rel = relativeUnder(outer.dir, inner.dir)
      if (rel === undefined) continue
      if (rel === '') {
        if (outer.name < inner.name) {
          problems.push({ partition: outer.name, level: 'warning', message: `和分区「${inner.name}」用的是同一个根目录，文件靠 include/exclude 区分` })
        }
        continue
      }
      problems.push({ partition: outer.name, level: 'warning', message: `分区「${inner.name}」嵌套在它下面（${rel}），那部分文件归「${inner.name}」` })
    }
  }
  return problems
}
