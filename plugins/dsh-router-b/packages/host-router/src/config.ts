/**
 * Declarative file partitions and task-to-partition routing.
 *
 * A partition is a named set of files: one absolute `root`, optional include and
 * exclude globs relative to it, and the operational knobs the dispatch side
 * needs (concurrency, preset, acceptance commands, standing brief). Everything
 * here is pure — no Cordis, no filesystem, no clock — so the routing rules are
 * testable without booting a harness. That matters: a wrong route silently sends
 * work into the wrong repository, and no agent inside the worker can notice.
 *
 * @module host-router/config
 */

import { isAbsolute, resolve } from 'node:path'

import type { OutletPolicy } from './outlets.ts'
import { REPORT_INSTRUCTION } from './report.ts'
import { type ScmConfig, scmProblem } from './scm.ts'

/** Reachability a partition declares, so its workers stop guessing. */
export type PartitionNetwork = 'intranet' | 'internet' | 'offline'

/** Git instructions attached to a worker's brief. */
export interface PartitionGit {
  /** Branch workers should be on. Created from HEAD when absent. */
  readonly branch?: string
  /** Extra git rule for this partition, appended verbatim. */
  readonly rule?: string
  /**
   * Code host of this checkout (GitHub or Gitea). With it, workers publish their
   * branch and open or update a pull request through `git_publish`, read checks
   * through `pr_status`, and ask for a merge through `pr_merge` (a human approves).
   */
  readonly scm?: ScmConfig
}

/** One declarative file partition. */
export interface PartitionConfig {
  /** Stable identifier used by tools, the board, and the manager key. */
  readonly name: string
  /** Absolute directory containing the partition's files; also the worker cwd. */
  readonly root: string
  /** Globs (POSIX, relative to `root`) selecting member files. Default `**`. */
  readonly include?: readonly string[]
  /** Globs removed from the member set after `include`. */
  readonly exclude?: readonly string[]
  /**
   * One or two sentences on what this partition contains. Shown to the LLM
   * classifier that routes free text the keyword score cannot settle.
   */
  readonly description?: string
  /** Words that route free-text tasks here. Case-insensitive. */
  readonly keywords?: readonly string[]
  /** Concurrent worker sessions allowed in this partition. Default 2; `0` means no partition cap. */
  readonly workers?: number
  /** Agent preset mounted for this partition's manager and workers. */
  readonly preset?: string
  /** Acceptance commands, run in `root` after a worker reports done. */
  readonly verify?: readonly string[]
  /** Standing instructions prepended to every worker prompt here. */
  readonly brief?: string
  /**
   * How this partition reaches the network, declared rather than guessed.
   *
   * The same machine cannot serve every partition: one root needs the intranet
   * VPN to reach its database, another needs public internet for a search, a
   * third must build offline. A worker that guesses gets a timeout it cannot
   * explain, so the answer travels in its brief instead.
   */
  readonly network?: PartitionNetwork
  /**
   * Git instructions for workers in this partition.
   *
   * Instructions only: the router does not run git. Every checkout it shares
   * with a human and with other agents, so a `checkout` / `reset` / `clean`
   * would move work that is not the worker's to move.
   */
  readonly git?: PartitionGit
  /**
   * What agents in this partition may do outside the sandbox: push and open
   * pull requests (`git`), run server commands (`ops`), open pages headless
   * (`browser`). `off` refuses, `confirm` asks a human every time, `allow` runs
   * (dangerous commands and merges still ask). See outlets.ts.
   */
  readonly outlets?: OutletPolicy
  /**
   * Use one long-lived manager child for this partition: tasks are handed to it
   * and it decomposes them into worker calls. Default follows the router-level
   * `manager` flag.
   */
  readonly manager?: boolean
}

/**
 * One credential reference the board reports presence for.
 *
 * Only the reference *name* appears in the board document, never a value: the
 * bridge asks `ctx.credentials.describe(ref)` and keeps
 * `configured`/`missing`/`unknown`. The `id` is what the UI keys its badge on.
 */
export interface CredentialRefConfig {
  /** Short id, used as the display label when `label` is absent. */
  readonly id: string
  /** Environment-variable name the harness resolves, e.g. `DEEPSEEK_API_KEY`. */
  readonly ref: string
  /** Display name the panel shows next to the badge, e.g. `DeepSeek`. */
  readonly label?: string
}

/**
 * Defaults for {@link CredentialRefConfig}.
 *
 * Both names are the ones the running build actually resolves: `DEEPSEEK_API_KEY`
 * (`dsh-llm-deepseek-api-key/src/config.ts:25`) and `EXA_API_KEY`
 * (`dsh-web-search-exa/lib/index.js:146`). Listing another provider is a config
 * change, not a code change.
 */
export const DEFAULT_CREDENTIAL_REFS: readonly CredentialRefConfig[] = [
  { id: 'deepseek', ref: 'DEEPSEEK_API_KEY', label: 'DeepSeek' },
  { id: 'exa', ref: 'EXA_API_KEY', label: 'Exa' },
]

/**
 * Default prompt-side context ceiling, in tokens.
 *
 * 256k, not the model's window: quality, not capacity, is the binding limit.
 * A session that has already spent 256k prompt tokens on its own history is
 * re-reading more than it is thinking, which is the observed way a worker
 * "forgets what it was doing" while still having room left in the window.
 */
export const DEFAULT_CONTEXT_LIMIT = 262_144

/** Router configuration; `partitions` is the only required member. */
export interface RouterConfig {
  readonly partitions: readonly PartitionConfig[]
  /** Directory for `board.json` and worker output logs. Default `<dsh home>/router`. */
  readonly boardDir?: string
  /** Partition used when free text matches nothing. Omission makes that an error. */
  readonly defaultPartition?: string
  /** Process-wide live-worker cap across all partitions. Default 8; `0` means no router cap. */
  readonly maxWorkers?: number
  /** Default for `PartitionConfig.manager`. Default true. */
  readonly manager?: boolean
  /** Retries allowed after an error stop. Default 1. */
  readonly maxRetries?: number
  /** Per-command acceptance timeout. Default 600000 ms. */
  readonly verifyTimeoutMs?: number
  /** Run declared acceptance commands at all. Default true. */
  readonly autoVerify?: boolean
  /**
   * Prompt-side context ceiling for handing more work to a session. Default
   * {@link DEFAULT_CONTEXT_LIMIT}.
   *
   * A worker keeps a 1M window, but a session already past this ceiling is no
   * longer a useful place to add work: it has lost the thread, and every extra
   * turn re-reads a transcript that is mostly history. Past it the router
   * refuses to attach — no new worker under a dispatcher that is over, no
   * resume into a worker that is over — and tells the caller to finish in
   * place. `0` disables the guard.
   */
  readonly contextLimitTokens?: number
  /**
   * Agent preset used for the router's anchor Agent and for any partition that
   * declares no `preset`. Default `standard`; `''` mounts no preset at all
   * (children then inherit their parent's composition).
   */
  readonly defaultPreset?: string
  /** Subagent provider name. Default `spawn` (the continuable in-process backend). */
  readonly provider?: string
  /** Delegation-depth cap handed to the seam, so workers cannot recurse forever. Default 2. */
  readonly maxDepth?: number
  /**
   * Smallest unique keyword score that routes free text without asking the LLM
   * classifier. Default {@link DEFAULT_AUTO_ROUTE_MIN_SCORE}.
   */
  readonly autoRouteMinScore?: number
  /** LLM classifier deadline in milliseconds. Default 20000. */
  readonly classifierTimeoutMs?: number
  /** Delay after boot before interrupted rows are resumed from their logs. Default 8000 ms. */
  readonly resumeDelayMs?: number
  /** Credential references whose presence the board reports. Default {@link DEFAULT_CREDENTIAL_REFS}. */
  readonly credentialRefs?: readonly CredentialRefConfig[]
  /**
   * Post a short 【进度提醒】 into the 作战室 when a task is suspended or
   * continued, when a prerequisite fails, and when a held-back stage starts.
   * Default true.
   */
  readonly progressNotices?: boolean
  /** Notices arriving within this window are posted as one message. Default 3000 ms. */
  readonly progressNoticeDelayMs?: number
  /**
   * Least time between two notices that each start a turn of the 作战室. A notice still
   * waiting in its queue is replaced instead (one queued notice at most). Default 60000 ms.
   */
  readonly progressNoticeMinGapMs?: number
  /** Most lines in one notice; older ones are folded into a count. Default 12. */
  readonly progressNoticeMaxLines?: number
  /**
   * A running worker whose log has been silent this many minutes gets one 【进度提醒】
   * (「没有动静」), which the 作战室 puts to the human as a question. Default 20; 0 turns it off.
   */
  readonly stallNoticeMinutes?: number
  /**
   * Compact the 作战室 (the anchor session) once its context passes this many tokens:
   * checked after each of its turns, while it is idle. DSH's own automatic compaction
   * belongs to the agent preset and starts much later on large-window models (about
   * 550k on a 1M window); this keeps the 作战室 near the size the human chose. After any
   * compaction the router re-posts the open tasks and questions (【作战室状态】).
   * Default 300000; 0 turns it off.
   */
  readonly anchorCompactTokens?: number
  /**
   * Headless screenshot command used by `browser_capture`:
   * `<command> <url> <out.png> [--full] [--wait ms]`. Default `/srv/workspace/bin/screenshot`.
   */
  readonly screenshotCommand?: string
  /**
   * Server scripts named in the worker brief: `build` builds host plugin code
   * without touching the running copy, `restart` restarts DSH safely (the
   * human runs it). Nothing is said about either when it is not set.
   */
  readonly hostScripts?: HostScripts
  /**
   * 快任务: small jobs outside every workspace (machine settings, a git command,
   * installing a tool). On by default; `false` turns it off.
   */
  readonly quick?: QuickConfig | false
}

/** Name the built-in 快任务 partition is routed by. */
export const QUICK_PARTITION = 'quick'

/**
 * The built-in 快任务 partition.
 *
 * Work that belongs to no project still deserves a worker rather than the
 * chat: "set the git user name", "what is using port 3000", "install jq". The
 * router hands such a job to one worker on the fast model, with no manager
 * and no branch, and answers the user at once; the result comes back later.
 * These workers have their own slots, so a quick job never waits behind a
 * workspace's long task and never takes a workspace's slot.
 */
export interface QuickConfig {
  /** Directory the worker starts in. Default the user's home directory. */
  readonly root?: string
  /** Concurrent quick workers. Default 2; `0` means no cap. */
  readonly workers?: number
  /** One line the classifier and the panel show. */
  readonly description?: string
  /** Outlet policy, as for any partition (dangerous commands still ask). */
  readonly outlets?: OutletPolicy
}

/** Default one-line description of the 快任务 partition. */
export const QUICK_DESCRIPTION = '快任务：不属于任何工作区的小活，例如改电脑配置、跑 git 命令、装工具、查端口或磁盘'

/**
 * Build the 快任务 partition, or undefined when it is off or a declared
 * partition already uses its name (the declared one wins).
 * @param raw - `RouterConfig.quick`.
 * @param declared - the normalised declared partitions.
 * @param home - default root.
 */
export function quickPartition(raw: QuickConfig | false | undefined, declared: readonly Partition[], home: string): Partition | undefined {
  if (raw === false) return undefined
  if (declared.some(partition => partition.name === QUICK_PARTITION)) return undefined
  const config = raw ?? {}
  const root = config.root ?? home
  if (typeof root !== 'string' || !isAbsolute(root)) throw new PartitionConfigError('quick.root must be an absolute path')
  const slots = config.workers ?? 2
  if (!Number.isInteger(slots) || slots < 0) throw new PartitionConfigError('quick.workers must be >= 0 (0 = unlimited)')
  for (const key of ['git', 'ops', 'browser'] as const) {
    const mode = config.outlets?.[key]
    if (mode !== undefined && mode !== 'off' && mode !== 'confirm' && mode !== 'allow') {
      throw new PartitionConfigError(`quick: outlets.${key} must be off, confirm or allow`)
    }
  }
  return {
    name: QUICK_PARTITION,
    root,
    dir: resolve(root),
    slots,
    managerEnabled: false,
    quick: true,
    description: config.description ?? QUICK_DESCRIPTION,
    // Membership by file would claim everything under the home directory;
    // a quick job is routed by name, never by a file path.
    include: [],
    ...config.outlets === undefined ? {} : { outlets: config.outlets },
  }
}

/** Why a task landed where it did; recorded so a human can audit routing. */
export type RouteReason = 'explicit' | 'files' | 'auto' | 'llm' | 'default' | 'manager'

/** One normalised partition. */
export interface Partition extends PartitionConfig {
  /** `resolve()`d root, so two spellings of one directory cannot split a queue. */
  readonly dir: string
  /** Effective per-partition concurrency; `0` means unlimited. */
  readonly slots: number
  /** Effective manager flag. */
  readonly managerEnabled: boolean
  /** The built-in 快任务 partition (see {@link QuickConfig}). */
  readonly quick?: boolean
}

/** Raised for configuration a deployment must fix, not for a task-level mistake. */
export class PartitionConfigError extends Error {
  constructor(message: string) {
    super(`host-router config: ${message}`)
    this.name = 'PartitionConfigError'
  }
}

/** Raised when a task cannot be attributed to exactly one partition. */
export class RouteError extends Error {
  constructor(message: string, readonly candidates: readonly string[] = []) {
    super(message)
    this.name = 'RouteError'
  }
}

/** Paths compare case-insensitively on Windows, where a drive letter has two spellings. */
const CASE_INSENSITIVE = process.platform === 'win32'

/** Convert Windows separators to POSIX so a glob means one thing on every host. */
export function toPosix(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * Translate one glob to a regular expression.
 *
 * The syntax is deliberately small: `**` crosses separators, `*` and `?` do not,
 * everything else is literal. It is not minimatch — a partition config that needs
 * brace expansion or negation is expressing something this router should model
 * explicitly instead.
 * @param pattern - glob relative to a partition root.
 * @returns an anchored regular expression.
 */
export function globToRegExp(pattern: string): RegExp {
  const normalised = toPosix(pattern).replace(/^\.\//, '')
  let source = ''
  for (let index = 0; index < normalised.length; index++) {
    const char = normalised[index]!
    if (char === '*') {
      if (normalised[index + 1] === '*') {
        // `**/` may match zero directories so `**/*.ts` also matches `a.ts`.
        if (normalised[index + 2] === '/') {
          source += '(?:.*/)?'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, CASE_INSENSITIVE ? 'i' : '')
}

/** The relative POSIX path of `candidate` under `dir`, or undefined when outside. */
export function relativeUnder(dir: string, candidate: string): string | undefined {
  const base = toPosix(dir).replace(/\/+$/, '')
  const target = toPosix(candidate)
  const baseCmp = CASE_INSENSITIVE ? base.toLowerCase() : base
  const targetCmp = CASE_INSENSITIVE ? target.toLowerCase() : target
  if (targetCmp === baseCmp) return ''
  if (!targetCmp.startsWith(`${baseCmp}/`)) return undefined
  return target.slice(base.length + 1)
}

/** Whether one absolute file path is a member of the partition. */
export function containsFile(partition: Partition, file: string): boolean {
  const relative = relativeUnder(partition.dir, file)
  if (relative === undefined) return false
  const include = partition.include ?? ['**']
  if (!include.some(pattern => globToRegExp(pattern).test(relative))) return false
  const exclude = partition.exclude ?? []
  return !exclude.some(pattern => globToRegExp(pattern).test(relative))
}

/**
 * Validate and normalise the partition list.
 *
 * Validation is eager and fatal: a partition with a relative root, a duplicate
 * name, or zero slots would otherwise fail per task, at the moment a worker is
 * already supposed to start. The error names the offending field so a deployment
 * fixes config instead of guessing.
 * @param partitions - raw configuration list.
 * @param defaults - router-level defaults applied to every partition.
 * @returns normalised partitions in configuration order.
 * @throws {PartitionConfigError} on any invalid entry.
 */
export function normalisePartitions(
  partitions: readonly PartitionConfig[],
  defaults: { readonly workers: number; readonly manager: boolean },
): readonly Partition[] {
  if (partitions.length === 0) {
    throw new PartitionConfigError('at least one partition is required')
  }
  const names = new Set<string>()
  const result: Partition[] = []
  for (const partition of partitions) {
    if (typeof partition.name !== 'string' || partition.name.trim() === '') {
      throw new PartitionConfigError('every partition needs a non-empty name')
    }
    if (names.has(partition.name)) {
      throw new PartitionConfigError(`duplicate partition name "${partition.name}"`)
    }
    names.add(partition.name)
    if (typeof partition.root !== 'string' || !isAbsolute(partition.root)) {
      throw new PartitionConfigError(`partition "${partition.name}" needs an absolute root`)
    }
    const slots = partition.workers ?? defaults.workers
    if (!Number.isInteger(slots) || slots < 0) {
      throw new PartitionConfigError(`partition "${partition.name}" needs workers >= 0 (0 = unlimited)`)
    }
    for (const pattern of [...partition.include ?? [], ...partition.exclude ?? []]) {
      if (typeof pattern !== 'string' || pattern === '') {
        throw new PartitionConfigError(`partition "${partition.name}" has an empty glob`)
      }
    }
    if (partition.network !== undefined
      && partition.network !== 'intranet'
      && partition.network !== 'internet'
      && partition.network !== 'offline') {
      throw new PartitionConfigError(
        `partition "${partition.name}" has network "${String(partition.network)}"; `
        + 'expected intranet, internet, or offline',
      )
    }
    if (partition.git?.scm !== undefined) {
      const problem = scmProblem(partition.git.scm)
      if (problem !== undefined) throw new PartitionConfigError(`partition "${partition.name}": ${problem}`)
    }
    for (const key of ['git', 'ops', 'browser'] as const) {
      const mode = partition.outlets?.[key]
      if (mode !== undefined && mode !== 'off' && mode !== 'confirm' && mode !== 'allow') {
        throw new PartitionConfigError(`partition "${partition.name}": outlets.${key} must be off, confirm or allow`)
      }
    }
    result.push({
      ...partition,
      dir: resolve(partition.root),
      slots,
      managerEnabled: partition.manager ?? defaults.manager,
    })
  }
  return result
}

/** Deepest partition whose membership contains `file`; nesting resolves to the tighter root. */
export function partitionOfFile(
  partitions: readonly Partition[],
  file: string,
): Partition | undefined {
  return partitions
    .filter(partition => containsFile(partition, file))
    .sort((left, right) => right.dir.length - left.dir.length)[0]
}

/**
 * Score free text against one partition.
 *
 * Signals are coarse and additive so a human can predict the outcome: a named
 * partition wins, a literal path inside it is strong, keyword hits rank the rest.
 * Nothing here guesses by similarity — a confident wrong route is worse than a
 * question.
 * @param partition - candidate partition.
 * @param text - the human's task text.
 * @returns a non-negative score; zero means "no evidence".
 */
export function scoreText(partition: Partition, text: string, extraKeywords: readonly string[] = []): number {
  const haystack = text.toLowerCase()
  let score = 0
  if (haystack.includes(partition.name.toLowerCase())) score += 4
  const seen = new Set<string>()
  for (const keyword of [...partition.keywords ?? [], ...extraKeywords]) {
    const needle = keyword.toLowerCase()
    if (needle === '' || seen.has(needle)) continue
    seen.add(needle)
    if (haystack.includes(needle)) score += 2
  }
  for (const token of text.split(/[\s"'`()<>[\]{},;]+/)) {
    if (!isAbsolute(token)) continue
    if (containsFile(partition, token)) score += 6
    else if (relativeUnder(partition.dir, token) !== undefined) score += 3
  }
  return score
}

/** Outcome of resolving a task to a partition. */
export interface RouteDecision {
  readonly partition: Partition
  readonly reason: RouteReason
  /** Ordered evidence, stored on the board so a human can audit the decision. */
  readonly because: readonly string[]
}

/**
 * Resolve a task to exactly one partition.
 *
 * Precedence is explicit name, then explicit files, then free text, then the
 * configured default. Ambiguity is an error rather than a coin flip: two
 * partitions tied on evidence means the config cannot answer, and a wrong guess
 * costs a whole worker session in the wrong repository.
 * @param partitions - normalised partitions.
 * @param input - explicit partition name, explicit files, or free text.
 * @param fallback - configured default partition name, if any.
 * @returns the decision plus its evidence trail.
 * @throws {RouteError} when the target is unknown, ambiguous, or unstated.
 */
export function resolveRoute(
  partitions: readonly Partition[],
  input: { readonly text?: string; readonly partition?: string; readonly files?: readonly string[] },
  fallback?: string,
  extraKeywords?: (partition: Partition) => readonly string[],
): RouteDecision {
  if (input.partition !== undefined) {
    const named = partitions.find(partition => partition.name === input.partition)
    if (named === undefined) {
      throw new RouteError(`unknown partition "${input.partition}"`, partitions.map(entry => entry.name))
    }
    return { partition: named, reason: 'explicit', because: [`named "${named.name}"`] }
  }

  const files = input.files ?? []
  if (files.length > 0) {
    const owners = new Set<string>()
    const evidence: string[] = []
    for (const file of files) {
      if (!isAbsolute(file)) throw new RouteError(`file "${file}" is not an absolute path`)
      const owner = partitionOfFile(partitions, file)
      if (owner === undefined) {
        throw new RouteError(`no partition contains "${file}"`, partitions.map(entry => entry.name))
      }
      owners.add(owner.name)
      evidence.push(`${file} -> ${owner.name}`)
    }
    if (owners.size > 1) {
      throw new RouteError(
        `files span several partitions (${[...owners].join(', ')}); split the task`,
        [...owners],
      )
    }
    const ownerName = [...owners][0]
    const owner = partitions.find(partition => partition.name === ownerName)
    if (owner === undefined) throw new RouteError('internal: resolved owner disappeared')
    return { partition: owner, reason: 'files', because: evidence }
  }

  const text = input.text ?? ''
  const scored = partitions
    .map(partition => ({ partition, score: scoreText(partition, text, extraKeywords?.(partition) ?? []) }))
    .filter(entry => entry.score > 0)
    .sort((left, right) => right.score - left.score)
  const best = scored[0]
  if (best !== undefined) {
    const tied = scored.filter(entry => entry.score === best.score)
    if (tied.length > 1) {
      throw new RouteError(
        `text matches ${tied.map(entry => entry.partition.name).join(' and ')} equally; name one`,
        tied.map(entry => entry.partition.name),
      )
    }
    return {
      partition: best.partition,
      reason: 'auto',
      because: [`score ${String(best.score)} from name/keyword/path evidence`],
    }
  }

  if (fallback !== undefined) {
    const named = partitions.find(partition => partition.name === fallback)
    if (named === undefined) {
      throw new RouteError(`default partition "${fallback}" does not exist`, partitions.map(entry => entry.name))
    }
    return { partition: named, reason: 'default', because: [`no evidence; default "${named.name}"`] }
  }
  throw new RouteError(
    'no partition matched; pass partition or files, or configure defaultPartition',
    partitions.map(entry => entry.name),
  )
}

/** Default unique keyword score that routes without the LLM: one name hit or two keyword hits. */
export const DEFAULT_AUTO_ROUTE_MIN_SCORE = 4

/** Smallest classifier confidence the router accepts. */
export const CLASSIFIER_MIN_CONFIDENCE = 0.5

/**
 * Directory names too generic to count as routing evidence. A top-level
 * `docs/` or `tools/` exists in several partitions and says nothing about
 * which one a request means.
 */
const GENERIC_DIRS = new Set([
  'docs', 'doc', 'tools', 'tool', 'scripts', 'script', 'deploy', 'memory', 'context', 'agents',
  'messages', 'todo', 'skills', 'proto', 'packages', 'platform', 'dashboard', 'ledger', 'src', 'lib',
  'test', 'tests', 'tmp', 'output', 'workspace', 'locale', 'subscriptions',
])

/**
 * Top-level directory names that are specific enough to act as keywords.
 * @param dirs - one partition's top-level directory names.
 * @returns lower-cased names, generic and dot/underscore-prefixed ones removed.
 */
export function directoryKeywords(dirs: readonly string[]): readonly string[] {
  return dirs
    .map(dir => dir.trim().toLowerCase())
    .filter(dir => dir.length >= 4 && !dir.startsWith('.') && !dir.startsWith('_') && !GENERIC_DIRS.has(dir))
}

/** What the LLM classifier answered, already validated. */
export interface ClassifierVerdict {
  /** A configured partition name, or `none`. */
  readonly partition: string
  readonly confidence: number
  readonly reason: string
}

/** One classification request: the text plus the facts the prompt shows. */
export interface ClassifierRequest {
  readonly text: string
  readonly system: string
  readonly prompt: string
}

/** Injected LLM call; resolves to the model's raw text, rejects on transport failure. */
export type Classifier = (request: ClassifierRequest) => Promise<string>

/**
 * Build the classifier prompt.
 * @param partitions - normalised partitions.
 * @param text - the demand text.
 * @param topDirs - partition name -> top-level directory names.
 * @returns system and user prompt text.
 */
export function buildClassifierPrompt(
  partitions: readonly Partition[],
  text: string,
  topDirs: Readonly<Record<string, readonly string[]>> = {},
): ClassifierRequest {
  const system = [
    'You route software tasks to exactly one project partition of a workspace.',
    'Read the partition descriptions and their top-level directories, then decide which partition the task is about.',
    'Answer with one JSON object and nothing else:',
    '{"partition":"<partition name>|none","confidence":<0..1>,"reason":"<one short sentence>"}',
    'Use "none" with low confidence when no partition fits. Do not invent partition names.',
  ].join('\n')
  const blocks = partitions.map((partition) => {
    const dirs = topDirs[partition.name] ?? []
    return [
      `- name: ${partition.name}`,
      `  root: ${partition.dir}`,
      `  description: ${partition.description?.trim() || '(none)'}`,
      ...(partition.keywords?.length ?? 0) > 0 ? [`  keywords: ${partition.keywords!.join(', ')}`] : [],
      `  top-level directories: ${dirs.length === 0 ? '(unknown)' : dirs.slice(0, 80).join(', ')}`,
    ].join('\n')
  })
  const prompt = ['Partitions:', ...blocks, '', 'Task:', text.slice(0, 4000)].join('\n')
  return { text, system, prompt }
}

/**
 * Parse and validate the classifier's raw answer.
 * @param raw - model text; may wrap the JSON in prose or a code fence.
 * @param partitions - legal partition names.
 * @returns the verdict.
 * @throws {Error} naming exactly what was wrong with the answer.
 */
export function parseClassifierOutput(raw: string, partitions: readonly Partition[]): ClassifierVerdict {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error(`classifier answered no JSON object: ${JSON.stringify(raw.slice(0, 160))}`)
  let value: unknown
  try {
    value = JSON.parse(raw.slice(start, end + 1))
  } catch (error) {
    throw new Error(`classifier JSON did not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
  const record = value as { partition?: unknown; confidence?: unknown; reason?: unknown }
  if (typeof record.partition !== 'string') throw new Error('classifier JSON has no string "partition"')
  const confidence = typeof record.confidence === 'number' ? record.confidence : Number(record.confidence)
  if (!Number.isFinite(confidence)) throw new Error('classifier JSON has no numeric "confidence"')
  const partition = record.partition.trim()
  if (partition !== 'none' && !partitions.some(entry => entry.name === partition)) {
    throw new Error(`classifier named unknown partition "${partition}"`)
  }
  return {
    partition,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: typeof record.reason === 'string' ? record.reason.trim().slice(0, 300) : '',
  }
}

/** Options for {@link resolveRouteSmart}. */
export interface SmartRouteOptions {
  /** Configured default partition, if any. */
  readonly fallback?: string
  /** LLM call; absent means "LLM unavailable". */
  readonly classifier?: Classifier
  /** Partition name -> top-level directory names, read once at activation. */
  readonly topDirs?: Readonly<Record<string, readonly string[]>>
  /** Unique keyword score needed to skip the classifier. */
  readonly minScore?: number
  /** Classifier deadline in milliseconds. Default 20000. */
  readonly timeoutMs?: number
}

/** Reject after `ms`, so a hung model call cannot hold a publish request. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => { reject(new Error(`classifier timed out after ${String(ms)} ms`)) }, ms)
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/**
 * Resolve a task to one partition, asking an LLM when keywords cannot decide.
 *
 * Order: explicit partition, then files, then a unique keyword score of at
 * least `minScore`, then the classifier. When the classifier is unavailable,
 * fails, or is unsure, the keyword rules of {@link resolveRoute} decide, and a
 * resulting error says why the classifier did not.
 * @param partitions - normalised partitions.
 * @param input - explicit partition name, explicit files, or free text.
 * @param options - classifier, directory hints, thresholds, default partition.
 * @returns the decision plus its evidence trail.
 * @throws {RouteError} when nothing can decide.
 */
export async function resolveRouteSmart(
  partitions: readonly Partition[],
  input: { readonly text?: string; readonly partition?: string; readonly files?: readonly string[] },
  options: SmartRouteOptions = {},
): Promise<RouteDecision> {
  const topDirs = options.topDirs ?? {}
  const extra = (partition: Partition): readonly string[] => directoryKeywords(topDirs[partition.name] ?? [])
  if (input.partition !== undefined || (input.files ?? []).length > 0) {
    return resolveRoute(partitions, input, options.fallback, extra)
  }
  const text = input.text ?? ''
  const minScore = options.minScore ?? DEFAULT_AUTO_ROUTE_MIN_SCORE
  const scored = partitions
    .map(partition => ({ partition, score: scoreText(partition, text, extra(partition)) }))
    .sort((left, right) => right.score - left.score)
  const best = scored[0]
  const unique = best !== undefined && best.score > 0 && scored.filter(entry => entry.score === best.score).length === 1
  if (best !== undefined && unique && best.score >= minScore) {
    return {
      partition: best.partition,
      reason: 'auto',
      because: [`score ${String(best.score)} from name/keyword/path evidence`],
    }
  }

  let llmProblem: string
  if (options.classifier === undefined) {
    llmProblem = 'LLM classifier unavailable'
  } else {
    try {
      const request = buildClassifierPrompt(partitions, text, topDirs)
      const raw = await withTimeout(options.classifier(request), options.timeoutMs ?? 20_000)
      const verdict = parseClassifierOutput(raw, partitions)
      const chosen = partitions.find(entry => entry.name === verdict.partition)
      if (chosen !== undefined && verdict.confidence >= CLASSIFIER_MIN_CONFIDENCE) {
        return {
          partition: chosen,
          reason: 'llm',
          because: [`llm confidence ${verdict.confidence.toFixed(2)}: ${verdict.reason || '(no reason given)'}`],
        }
      }
      llmProblem = `LLM classifier answered "${verdict.partition}" with confidence ${verdict.confidence.toFixed(2)}`
        + ` (needs ${String(CLASSIFIER_MIN_CONFIDENCE)}): ${verdict.reason}`
    } catch (error) {
      llmProblem = `LLM classifier failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  try {
    const decision = resolveRoute(partitions, input, options.fallback, extra)
    return { ...decision, because: [...decision.because, llmProblem] }
  } catch (error) {
    if (error instanceof RouteError) throw new RouteError(`${error.message} (${llmProblem})`, error.candidates)
    throw error
  }
}
/**
 * What each declared network means for the worker holding the brief.
 *
 * Phrased as an instruction plus a fallback: a worker that cannot reach a host
 * should say which host and stop, not silently try a public mirror or a VPN.
 */
const NETWORK_BRIEF: Readonly<Record<PartitionNetwork, string>> = {
  intranet: 'Network: this partition is reached over the intranet VPN. If a host is unreachable, name it '
    + 'and stop; do not retry through public mirrors or a different route.',
  internet: 'Network: this partition needs public internet. Do not assume an intranet host is reachable, '
    + 'and do not route traffic through the VPN.',
  offline: 'Network: this partition builds offline. Do not fetch dependencies or call any network '
    + 'service; if the task needs one, stop and report which one.',
}

/** Server scripts a worker may be told about. Each is named in the brief only when configured. */
export interface HostScripts {
  /** Builds host plugin code somewhere safe (for example into `lib.next/`) without touching the running copy. */
  readonly build?: string
  /** Restarts DSH safely; run by the human, so the brief only names it. */
  readonly restart?: string
}

/**
 * The standing brief a worker receives before its task body.
 *
 * A worker is a fresh session with no memory of the conversation that produced
 * the task, so the partition's identity, its scope and the reporting contract
 * travel in the prompt. Acceptance commands are run once, by the router, after
 * the worker answers; the brief names them so the worker knows the bar, but
 * does not ask the worker to run them as well. Server script paths come from
 * the router config (`hostScripts`) and are left out when it has none.
 * @param partition - the partition the worker runs in.
 * @param options - whether acceptance commands will be run, the task id, and the configured host scripts.
 * @returns the brief text.
 */
export function partitionBrief(
  partition: Partition,
  options: { readonly verify: boolean; readonly taskId?: string; readonly hostScripts?: HostScripts },
): string {
  if (partition.quick === true) return quickBrief(partition, options)
  const lines = [
    `You are a worker for the "${partition.name}" partition; your working directory is ${partition.dir}.`,
    'For work of three or more steps, keep a `todo_write` checklist (the board shows it); skip it for small jobs.',
    '',
    'Rules:',
    `- Change files only under ${partition.dir}${partition.include === undefined ? '' : ' that match the member globs'}; reading elsewhere is fine.`,
    '- If you need a change outside this partition or another task first, call `task_suspend`'
      + (options.taskId === undefined ? '' : ` ("${options.taskId}")`)
      + ' with a one-line `reason` and a self-contained `prerequisite` (plus `partition` if it belongs elsewhere), then end.',
    '- Run only the tests that cover what you changed; a full suite only when the task asks for it.',
    '- Do not probe the environment up front.',
    '- When you cannot go on without the human (the task reads two ways, access or a credential is missing, the next step'
      + ' could destroy data, or the same approach failed twice), do not guess and do not keep retrying: call `task_control`'
      + ` \`block\`${options.taskId === undefined ? ' on your task' : ` on "${options.taskId}"`} with one clear question and two or three options, then end.`,
    '- Server changes (services, system files, media, DNS, firewall, users) go through `ops_run`.',
    '- Never write a host plugin\'s `lib/` and never stop or restart DSH. Client bundles may be rebuilt.',
  ]
  const scripts = options.hostScripts
  if (scripts?.build !== undefined && scripts.build.trim() !== '') {
    lines.push(`- Build host code with \`${scripts.build.trim()}\` and say a restart is needed`
      + (scripts.restart !== undefined && scripts.restart.trim() !== '' ? ` (the human runs \`${scripts.restart.trim()}\`).` : '.'))
  }
  lines.push('- For UI or site evidence use `browser_capture` and list the image paths in your report.')
  if (partition.include !== undefined) lines.push(`Member files: ${partition.include.join(', ')}.`)
  if (partition.exclude !== undefined && partition.exclude.length > 0) {
    lines.push(`Out of scope: ${partition.exclude.join(', ')}.`)
  }
  if (partition.brief !== undefined && partition.brief.trim() !== '') {
    lines.push('', 'Standing instructions for this partition:', partition.brief.trim())
  }
  if (partition.network !== undefined) lines.push('', NETWORK_BRIEF[partition.network])
  if (partition.git !== undefined) {
    const gitRules = [
      partition.git.branch === undefined ? undefined : `Work on branch "${partition.git.branch}" (create it from HEAD if missing).`,
      'Never switch branches, reset, clean or force-push: the tree is shared.',
      partition.git.rule,
    ].filter((rule): rule is string => rule !== undefined && rule.trim() !== '')
    if (partition.git.scm !== undefined) {
      gitRules.push(`Code host: ${partition.git.scm.provider} ${partition.git.scm.repo}. Publish a committed change with \`git_publish\`, `
        + 'read CI with `pr_status`; never merge or push the default branch (`pr_merge` waits for the human).')
    }
    if (gitRules.length > 0) lines.push('', 'Git:', ...gitRules)
  }
  if (options.verify && partition.verify !== undefined && partition.verify.length > 0) {
    lines.push('', 'After you answer, the router runs these acceptance commands once:', ...partition.verify.map(command => `  ${command}`))
  }
  lines.push('', ...REPORT_INSTRUCTION, 'Only report what you actually observed.')
  return lines.join('\n')
}

/**
 * Brief for a 快任务 worker: one small job outside every workspace, done
 * quickly and reported in a few lines. No checklist (a two-command job does not
 * need one), no branch, no project edits.
 */
function quickBrief(partition: Partition, options: { readonly taskId?: string }): string {
  return [
    'You are a 快任务 worker: one small job outside every project workspace (a machine setting, a git command,',
    `a tool install, a port, process or disk check). Your working directory is ${partition.dir}; cd where the job says.`,
    '',
    'Rules:',
    '- Do just the job in as few steps as it takes. No `todo_write` plan.',
    '- Do not edit a project workspace\'s source; if the job is project work, say so in one line and stop.',
    '- Never switch branches, reset, clean or force-push a repository you did not create for this job.',
    '- Hard-to-undo machine changes (stop or restart a service, delete files, firewall, users, reboot, package',
    '  removal) go through `ops_run`; installs, config values and read-only looks may use the shell.',
    '- Never print a secret; say where it is set.',
    ...options.taskId === undefined ? [] : [`- Your task id is ${options.taskId}.`],
    '',
    'Answer in two to five lines: what you ran and what came out (exact value, version or error). Only report what you observed.',
  ].join('\n')
}
