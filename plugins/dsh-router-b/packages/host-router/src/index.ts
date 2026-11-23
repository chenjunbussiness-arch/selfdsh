/**
 * Host-side router for DeepSeek Harness: file partitions, a per-partition
 * manager, and one continuable worker session per task.
 *
 * ```
 * your session (level 1: assign)
 *   └── route_task(text) ── resolves the partition from config ──┐
 *                                                                │
 *   partition manager child (level 2: direct) ← only if enabled  │
 *     ├── route_task(text, partition, parent_task)  → new worker │
 *     └── task_resume(worker task, text)            → same worker│
 *                                                                ▼
 *   worker child, cwd = partition root, released when it settles
 * ```
 *
 * Three facts about the running build drive the plumbing, all read from the
 * installed JavaScript rather than assumed:
 *
 * 1. **`cwd` on the subagent *service* roots a child in a partition.**
 *    `startActivation({ cwd })` → `SubagentManager.resolveDirectory` (an absolute
 *    path is used verbatim) → `workingDirectory.set(child, cwd)` before the
 *    child's first turn, so sandbox policy sees the partition directory. A
 *    worker therefore needs no "cd first" step. The `subagent` *tool*'s own
 *    `cwd` parameter is not a stable surface — present in 0.2.2-rc.3, absent from
 *    the 0.2.2-rc.5 tool source — while the service keeps `cwd` in both.
 * 2. **A worker is an ordinary Session**, and `dsh-tool-todo`'s `todo_write`
 *    appends `todo/write` events to it. That log is where "how far along is this
 *    worker" comes from; the board stores the worker's `sessionId` so the UI can
 *    read it.
 * 3. **No live child survives this process.** The subagent manager's activation
 *    map is process-local, so the board is the durable record, and a row left
 *    `running` by a dead process is reconciled from its session log instead of
 *    being trusted.
 *
 * There is no human acceptance step: a worker or manager that ends normally is
 * recorded as `done` and its report flows back up the chain (worker -> manager ->
 * the 作战室 anchor conversation, which relays it to the user).
 *
 * @module host-router
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import {
  DEFAULT_CONTEXT_LIMIT,
  DEFAULT_CREDENTIAL_REFS,
  PartitionConfigError,
  QUICK_PARTITION,
  normalisePartitions,
  partitionBrief,
  quickPartition,
  resolveRoute,
  resolveRouteSmart,
} from './config.ts'
import type { Classifier, Partition, RouteDecision, RouteReason, RouterConfig } from './config.ts'
import { formatTokens, pressureTokensOf } from './context.ts'
import { parseWorkerReport } from './report.ts'
import { INTERRUPTED_NOTE, SETTLED, TaskBoard, isDead, isFinished, mark, nextTaskId, summarize, tail } from './board.ts'
import { dependencyError, gateOf, gateOfIds, groupProgress, progressLine, rootOf } from './order.ts'
import type { Gate, GroupProgress } from './order.ts'
import type { RouterTask, TaskState } from './board.ts'
import { cancelWorker, continueWorker, runVerify, startWorker, textOf } from './dispatch.ts'
import { buildSnapshot, createLogReader, foldWorkerLog } from './snapshot.ts'
import type { RouterSnapshot, TaskView } from './snapshot.ts'
import { BRIDGE_BASE, BridgeError, createRoutes, credentialSourceOf } from './bridge.ts'
import { FileListError, listPartitionDir, partitionProblems } from './files.ts'
import type { PartitionProblem } from './files.ts'
import type { BridgeDeps, PublishResult, UiCredentialView } from './bridge.ts'
import { randomUUID } from 'node:crypto'
import { TIERS, TierStore, classifyTier, defaultTiers, isTier, managerRouteOf, normaliseManager, normaliseSettings } from './tier.ts'
import { MemoryStore, entryOf, memoryBrief, renderTranscript, sessionRoster, workLine } from './memory.ts'
import { DEFAULT_POLICY, OutletStore, classifyCommand, gitFacts, hostAllowed, pushableBranch, run, runShell } from './outlets.ts'
import type { Approval, OutletKind, OutletMode } from './outlets.ts'
import { createScmClient, envToken } from './scm.ts'
import type { ScmClient } from './scm.ts'
import { liveSegments } from './live.ts'
import type { ModelOption, Tier, TierDecision, TierRoute } from './tier.ts'
import type { ContentBlock, CredentialsServiceLike, LiveAgent, LlmRuntimeLike, PluginContext, SubagentActivation, ToolRunContext, WebRouteLike } from './types.ts'

/** Stable plugin name. */
export const name = 'host-router'

/** The tool registry and the subagent seam are hard dependencies. */
export const inject = ['tools', 'subagents']

/** The part of the web app's `connection` service the bridge uses to check a login. */
interface LoginCheck {
  /** `undefined` for a logged-in browser (or API peer), else 401 / 403. */
  requestRejection?(request: import('node:http').IncomingMessage): number | undefined
}

/**
 * Put the web app's own login in front of one bridge route.
 *
 * The host web server matches the longest prefix first, so `/api/router/*`
 * wins over the app's `/api` route and would skip its login check. Without
 * this, anything that can reach the port (a worker's shell included) could
 * read the board and approve its own merge or dangerous command. Fails closed:
 * with no login service the route answers 503.
 * @param route - the route as the bridge builds it.
 * @param connection - reads the `connection` service at request time.
 * @returns the same route behind the login check.
 */
export function requireLogin(route: WebRouteLike, connection: () => LoginCheck | undefined): WebRouteLike {
  return {
    kind: route.kind,
    path: route.path,
    handler: async (req, res) => {
      const check = connection()
      const rejection = typeof check?.requestRejection === 'function' ? check.requestRejection(req) : 503
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'login service unavailable')
        return
      }
      await route.handler(req, res)
    },
  }
}

/** Default concurrent workers per partition. */
const DEFAULT_SLOTS = 2
/** Default process-wide concurrent worker cap. */
const DEFAULT_MAX_WORKERS = 8
/** Default acceptance timeout: ten minutes. */
const DEFAULT_VERIFY_TIMEOUT = 600_000
/** Default delegation-depth cap: a worker may delegate once, no deeper. */
const DEFAULT_MAX_DEPTH = 2


/** Normalise task text for a pass-through comparison (whitespace and case). */
function normaliseBody(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Warning when a manager handed its whole request to a single worker unchanged.
 *
 * The manager level exists to split and coordinate. A manager that copies its
 * own brief into one worker has produced the flat master/slave shape the
 * three-level chain is meant to avoid; the task still finishes, but the report
 * says so and the router logs it.
 *
 * @param body - the manager's own task text.
 * @param children - the workers it dispatched.
 * @returns the warning text, or `undefined` when the split looks real.
 */
function relayWarning(body: string, children: readonly RouterTask[]): string | undefined {
  if (children.length !== 1) return undefined
  const child = children[0]
  if (child === undefined) return undefined
  const mine = normaliseBody(body)
  const theirs = normaliseBody(child.body)
  if (mine === '' || theirs === '') return undefined
  const relayed = theirs.includes(mine) || (mine.includes(theirs) && theirs.length > mine.length * 0.8)
  return relayed
    ? 'manager relayed the request unchanged to a single worker (no split); the manager level added no decomposition'
    : undefined
}

/** Text a manager child receives in place of a worker brief. */
function managerPrompt(input: {
  readonly partition: Partition
  readonly taskId: string
  readonly body: string
  /** Prompt-token ceiling past which the router refuses further dispatch. */
  readonly contextLimit: number
  /** What the partition remembers: notes, recent work, worker sessions (`memoryBrief`). */
  readonly memory?: string
}): string {
  return [
    `You are the manager of the "${input.partition.name}" partition (files under ${input.partition.dir}).`,
    'Every request for this partition comes to you; what earlier requests did is in the partition memory below.',
    '`session_list` / `session_read` show what workers did; `task_resume` continues one.',
    '',
    'Rules:',
    '- Dispatch only. Never edit files, run shell or build commands, or do the task yourself, however small.',
    `- Start at least one worker with \`route_task\` (partition "${input.partition.name}", parent_task "${input.taskId}") before you answer, or the task fails.`,
    '- Split, do not relay: two or more deliverables (artifacts, areas, or phases like investigate / fix / verify)',
    '  need two or more workers. Give each worker only its slice plus the context it needs; it sees nothing else.',
    '- Start independent workers in the same turn. Publish pieces that must wait now, with `stage` (1, 2, ...)',
    '  or `depends_on`; the router starts them in order. A worker may `task_suspend` for a missing prerequisite.',
    '- Do not wait for approval. Ask only when the request reads two ways or a step could destroy data:',
    `  \`task_control\` action \`block\` on "${input.taskId}" with the question as \`value\`, then end.`,
    '- Code ships with `git_publish` and merges only with `pr_merge` (it waits for the human). Server changes go',
    '  through `ops_run`. Move a failure another partition or model would fix with `task_reassign`.',
    '- Keep a `todo_write` checklist: one step per worker plus a consolidate step, one in_progress at a time,',
    '  updated as workers start and report, all completed before you answer.',
    '',
    'Steps:',
    '1. Split the request; do not invent work.',
    '2. Per piece: `task_resume` an earlier worker only when its `touched` files overlap this piece (`session_read`',
    '   it first); otherwise `route_task`. When in doubt, a new worker.',
    '3. `route_task` returns at once. Call `wait_agent` until every worker has reported; your closing message is',
    `   what the dispatcher receives. When only staged, suspended or waiting tasks are left, loop \`task_wait\` with parent_task "${input.taskId}"`,
    '   until all settle. Re-brief or `task_control` `retry` a failed piece once; if it fails again, say so.',
    '4. Record lasting facts with `partition_memory` action `note` (one short fact each, nothing the work log',
    '   already keeps); `forget` notes that proved wrong.',
    '5. Answer with one report for the human in the request\'s language: what was done, how, the results the',
    '   workers observed, and every artifact and screenshot path verbatim as absolute paths. No acceptance step follows.',
    '',
    ...input.contextLimit > 0
      ? [`Delegation stops at ${formatTokens(input.contextLimit)} prompt tokens; if a dispatch is refused for`,
        'that reason, say so in your answer instead of doing the work yourself.']
      : [],
    '',
    ...input.memory === undefined ? [] : [input.memory, ''],
    `--- request ${input.taskId} ---`,
    input.body,
  ].join('\n')
}
/** Compose the text one worker receives: partition brief, then the task body. */
function workerPrompt(partition: Partition, taskId: string, body: string, autoVerify: boolean): string {
  return `${partitionBrief(partition, { verify: autoVerify, taskId })}\n\n---\n\nTask ${taskId}:\n${body}`
}

/** Title of the router's chat-facing anchor Session. */
const ANCHOR_TITLE = '作战室'

/**
 * Standing instructions of the anchor ("作战室") Session: a dispatcher that
 * chats with the human, hands work to partitions, and relays the reports.
 */
function anchorInstructions(partitions: readonly Partition[]): string {
  return [
    `# 你是「${ANCHOR_TITLE}」`,
    '你是用户唯一的对话入口和调度员：能直接答的直接答，要动手的派给分区，做完用聊天口吻汇报。',
    '',
    '## 分区',
    ...partitions.filter(partition => partition.quick !== true).map(partition => `- ${partition.name}: ${partition.dir}`
      + (partition.managerEnabled ? '' : '（无 manager）')
      + (partition.description === undefined ? '' : ` — ${partition.description.replace(/\s+/g, ' ').trim()}`)),
    '',
    '## 规则',
    '1. 闲聊、问答、解释，以及不用动手就能答的：直接回答，不派任务。',
    '2. 要动手的（改代码、跑命令、看文件、开网页、截图、部署等）：你只转发，拆解和排序交给分区 manager。',
    '   - 涉及几个分区就发几条 `route_task`，`partition` 填分区名；`text` 写用户原话里属于这个分区的部分，加上执行方',
    '     需要的上下文（URL、路径、要求、产物）。执行方看不到对话，要自包含；不要替 manager 拆，也不要加实现方案。',
    '   - 跨分区有先后的，后一条带 `depends_on`（前一条的任务号）。全部在同一轮发完，不传 `parent_task`。',
    '   - 标了「无 manager」的分区由你按工作项拆开各发一条。判断不了分区就省略 `partition`。',
    ...partitions.some(partition => partition.quick === true) ? [
      `   - 快任务：不属于任何工作区的小活（改电脑配置、git 命令、装工具、查端口/进程/磁盘），\`partition\` 填 \`${QUICK_PARTITION}\`，`,
      '     由快模型 worker 直接做。纯问答仍按规则 1 直接回答。',
    ] : [],
    '3. 你自己不动手：不用 bash、pwsh、write、edit、apply_patch、web_fetch、browser 等。可以用 `task_board` /',
    '   `task_progress` 查进度，用 `read` / `read_image` 看产出。',
    '4. 派完用一两句话告诉用户交给了哪个分区、任务号，然后结束这一轮，不等待、不轮询。',
    '5. 收到子任务结束的通知，先用 `task_board`（带 task_id）看状态：还是 running / dispatched / queued 就最多说一句',
    '   「还在做」；真正结束才汇报，同一个任务不重复汇报。汇报写做了什么、怎么做的、关键结果；截图用',
    '   `![说明](</截图的绝对路径.png>)` 显示，并用 `present` 发布（`files: [{ path, description }]`）；其他产物写绝对路径；',
    '   失败就说清楚失败在哪和下一步。没有验收环节，不提“验收”。',
    '6. 追问细节：`task_board`（带 task_id）、`session_read`；在同一个执行者上继续用 `task_resume`；分区以前做过什么用',
    '   `partition_memory`（action `read`）。',
    '7. 用户要把任务挂起等前置：`task_suspend`，填 task_id 和原因，前置写在 `prerequisite`（会新建前置任务）或在',
    '   `wait_for` 填已有任务号，前置完成后自动接着做。只是先放着的只写原因，之后用 `task_control` 的 `resume` 继续。',
    '8. 「【进度提醒】」开头的消息来自路由器：一两句话转告用户进度，不派任务，也不调用工具。',
  ].join('\n')
}

/** Directory the anchor Session lives in: the partitions' shared parent, else the first root. */
function anchorDirOf(all: readonly Partition[]): string {
  // The 快任务 root (home) is not a workspace and would pull the anchor out of them.
  const partitions = all.filter(partition => partition.quick !== true)
  const parents = [...new Set(partitions.map(partition => dirname(partition.dir)))]
  return parents.length === 1 ? parents[0]! : (partitions[0]?.dir ?? process.cwd())
}

/** Deep-freeze a plain value, as the harness does with every published message. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Build one user-role message the way `dsh-llm` `createUserMessage` does
 * (fresh id, frozen), without importing an `@deepseek-ai` package at runtime.
 */
function userMessage(text: string): unknown {
  return deepFreeze({
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: randomUUID(),
  })
}

/** The per-agent `systemPrompt` face this plugin uses. */
interface SystemPromptLike {
  section(section: { readonly name: string; readonly order: number; readonly text: string }): unknown
  getSectionOrder?(name: string): number | undefined
}

/** Arguments accepted by `route_task`. */
interface RouteArgs {
  readonly text: string
  readonly partition?: string
  readonly files?: readonly string[]
  readonly subject?: string
  readonly priority?: number
  readonly parent_task?: string
  readonly verify?: readonly string[]
  /** Explicit difficulty tier; overrides classification. */
  readonly tier?: string
  /** Task ids that must finish before this one may start. */
  readonly depends_on?: readonly string[]
  /** Ordered phase among siblings under the same parent_task. */
  readonly stage?: number
}

/** Mount the router: partitions, board, tools, and the worker lifecycle. */
export async function apply(ctx: PluginContext, config: RouterConfig): Promise<void> {
  const declared = normalisePartitions(config.partitions, {
    workers: DEFAULT_SLOTS,
    manager: config.manager !== false,
  })
  // 快任务: a built-in partition for jobs outside every workspace (see QuickConfig).
  const quick = quickPartition(config.quick, declared, homedir())
  const partitions: readonly Partition[] = quick === undefined ? declared : [...declared, quick]
  /** Names of partitions whose workers do not count against the router-wide cap. */
  const quickNames = new Set(partitions.filter(partition => partition.quick === true).map(partition => partition.name))
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const boardDir = config.boardDir === undefined ? join(home, 'router') : resolve(config.boardDir)
  const snapshotPath = join(boardDir, 'snapshot.json')
  await mkdir(boardDir, { recursive: true })
  /** Identity of this plugin activation, so a restart can spot its own leftovers. */
  const runToken = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const board = await TaskBoard.open(boardDir, runToken)
  /**
   * Partition memory: every settled row lands in its partition's work log, so the
   * next manager of that partition starts knowing what was done before.
   */
  const memory = await MemoryStore.open(join(boardDir, 'memory'), partitions.map(partition => partition.name))
  const outlets = await OutletStore.open(boardDir)
  {
    // First boot with memory: the board already holds the partition's history.
    const byId = new Map(board.list().map(row => [row.id, row]))
    for (const partition of partitions) {
      const settled = board.inPartition(partition.name).filter(task => SETTLED.has(task.state))
      const seeded = await memory.seed(partition.name, settled.map(task => entryOf(task, rootOf(task, byId).id)))
        .catch((error: unknown) => {
          ctx.logger.warn(`host-router: could not seed ${partition.name} memory: ${String(error)}`)
          return 0
        })
      if (seeded > 0) ctx.logger.info(`host-router: ${partition.name} memory seeded with ${String(seeded)} finished task(s)`)
    }
  }
  board.onSettled((task) => {
    const byId = new Map(board.list().map(row => [row.id, row]))
    void memory.record(task.partition, entryOf(task, rootOf(task, byId).id)).catch((error: unknown) => {
      ctx.logger.warn(`host-router: could not record ${task.id} in ${task.partition} memory: ${String(error)}`)
    })
  })

  const provider = config.provider ?? 'spawn'
  const maxWorkers = config.maxWorkers ?? DEFAULT_MAX_WORKERS
  const autoVerify = config.autoVerify !== false
  const verifyTimeout = config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT
  const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH
  /** Preset for the anchor and for partitions without one; `''` means none. */
  const defaultPreset = config.defaultPreset === '' ? undefined : (config.defaultPreset ?? 'standard')
  const presetOf = (partition: { readonly preset?: string }): string | undefined => partition.preset ?? defaultPreset
  /** Zero disables the guard; otherwise every attach point compares against it. */
  const contextLimit = config.contextLimitTokens ?? DEFAULT_CONTEXT_LIMIT

  // --- Level 1 routing inputs -------------------------------------------------
  /** Top-level directory names per partition, read once: routing hints for keywords and the LLM. */
  const topDirs: Record<string, readonly string[]> = {}
  for (const partition of partitions) {
    try {
      const entries = await readdir(partition.dir, { withFileTypes: true })
      topDirs[partition.name] = entries
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .map(entry => entry.name)
        .sort()
    } catch (error) {
      topDirs[partition.name] = []
      ctx.logger.warn(`host-router: cannot list ${partition.dir}: ${String(error)}`)
    }
  }
  const classifierTimeout = config.classifierTimeoutMs ?? 20_000

  /**
   * One LLM classification call through `ctx.llm`, built without importing
   * `@deepseek-ai/dsh-llm`: the request message is a plain one-shot user input
   * and the answer is the concatenated `text-delta` chunks.
   */
  const classifier: Classifier | undefined = (() => {
    const llm = ctx.get('llm') as LlmRuntimeLike | undefined
    if (llm === undefined || typeof llm.prepareCall !== 'function') {
      ctx.logger.warn('host-router: ctx.llm unavailable; routing falls back to keywords only')
      return undefined
    }
    return async (request) => {
      const selection = ctx.get('agentDefaultModel')?.currentSelection()
      if (selection === undefined) throw new Error('no default model selection (agentDefaultModel)')
      const signal = AbortSignal.timeout(classifierTimeout)
      const call = await llm.prepareCall(
        { provider: selection.provider, model: selection.model, maxTokens: 1024 },
        signal,
        (controls, model) => {
          // Least reasoning the model offers: classification needs an answer, not a plan.
          const least = model.reasoning?.efforts?.[0]?.id
          return { ...controls, ...least === undefined ? {} : { reasoningEffort: least } }
        },
      )
      let text = ''
      for await (const chunk of call.stream({
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
        system: request.system,
        signal,
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(`model call ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'no message'}`)
        }
      }
      return text
    }
  })()

  // --- Difficulty tiers --------------------------------------------------------
  const tierStore = await TierStore.open(join(boardDir, 'tiers.json'))
  const llmService = ctx.get('llm') as LlmRuntimeLike | undefined

  /** One short text answer from an explicit route (used by the tier classifier). */
  const tierCall = llmService === undefined || typeof llmService.prepareCall !== 'function'
    ? undefined
    : async (route: TierRoute, system: string, prompt: string): Promise<string> => {
      const signal = AbortSignal.timeout(classifierTimeout)
      const call = await llmService.prepareCall(
        { provider: route.provider, model: route.model, maxTokens: 256 },
        signal,
        (controls, model) => {
          const least = model.reasoning?.efforts?.[0]?.id
          return { ...controls, ...least === undefined ? {} : { reasoningEffort: least } }
        },
      )
      let text = ''
      for await (const chunk of call.stream({
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        system,
        signal,
      })) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
        else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
          throw new Error(`model call ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'no message'}`)
        }
      }
      return text
    }

  /** Every advertised model, read live so the panel offers what is really routable. */
  const modelOptions = async (): Promise<ModelOption[]> => {
    if (llmService?.listProviders === undefined || llmService.listModels === undefined) return []
    const options: ModelOption[] = []
    for (const provider of llmService.listProviders()) {
      try {
        for (const model of await llmService.listModels(provider.id)) {
          let efforts: string[] | undefined
          try {
            const info = await llmService.resolveModelInfo?.(provider.id, model.id)
            const ids = info?.reasoning?.efforts?.map(effort => effort.id)
            if (ids !== undefined && ids.length > 0) efforts = ids
          } catch { /* efforts are optional */ }
          options.push({
            provider: provider.id,
            providerName: provider.name,
            model: model.id,
            name: model.name,
            ...efforts === undefined ? {} : { efforts },
          })
        }
      } catch (error) {
        ctx.logger.warn(`host-router: listModels(${provider.id}) failed: ${String(error)}`)
      }
    }
    return options
  }

  /** Default selection of the profile, as a route. */
  const defaultRoute = (): TierRoute | undefined => {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    return selection === undefined ? undefined : {
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
    }
  }

  let cachedOptions: { at: number; value: ModelOption[] } | undefined
  const cachedModelOptions = async (): Promise<ModelOption[]> => {
    if (cachedOptions !== undefined && Date.now() - cachedOptions.at < 60_000) return cachedOptions.value
    cachedOptions = { at: Date.now(), value: await modelOptions() }
    return cachedOptions.value
  }

  /** Effective route per tier: saved choice, else the computed default. */
  const effectiveTiers = async (): Promise<Record<Tier, TierRoute | undefined>> => {
    const saved = tierStore.get().tiers
    const defaults = defaultTiers(await cachedModelOptions(), defaultRoute())
    return {
      easy: saved.easy ?? defaults.easy,
      medium: saved.medium ?? defaults.medium,
      hard: saved.hard ?? defaults.hard,
    }
  }

  /** Model route for partition managers: saved choice, else the strongest advertised model. */
  const managerRoute = async (): Promise<ReturnType<typeof managerRouteOf>> =>
    managerRouteOf(tierStore.get(), await cachedModelOptions(), defaultRoute())

  /** Classify one route_task call; never throws. */
  const decideTier = async (args: RouteArgs): Promise<TierDecision | undefined> => {
    if (!tierStore.get().auto && !isTier(args.tier)) return undefined
    const easy = (await effectiveTiers()).easy
    return await classifyTier(
      { text: args.text, ...args.files === undefined ? {} : { files: args.files }, ...args.tier === undefined ? {} : { tier: args.tier } },
      tierCall,
      easy,
    )
  }

  /** Bridge face: read + write tier settings. */
  const tierFace = {
    read: async () => {
      const settings = tierStore.get()
      const models = await cachedModelOptions()
      const defaults = defaultTiers(models, defaultRoute())
      return {
        auto: settings.auto,
        saved: settings.tiers,
        effective: await effectiveTiers(),
        defaults,
        defaultModel: defaultRoute() ?? null,
        manager: settings.manager ?? 'strongest',
        managerEffective: await managerRoute(),
        models,
      }
    },
    write: async (body: Record<string, unknown>) => {
      const current = tierStore.get()
      const incoming = normaliseSettings({
        auto: typeof body['auto'] === 'boolean' ? body['auto'] : current.auto,
        tiers: (typeof body['tiers'] === 'object' && body['tiers'] !== null
          ? { ...current.tiers, ...body['tiers'] as Record<string, TierRoute> }
          : current.tiers),
      })
      // Drop a tier explicitly reset to null.
      const tiers: Partial<Record<Tier, TierRoute>> = { ...incoming.tiers }
      const raw = body['tiers'] as Record<string, unknown> | undefined
      for (const tier of TIERS) if (raw !== undefined && raw[tier] === null) delete tiers[tier]
      // Only routes the runtime advertises may be saved.
      const models = await cachedModelOptions()
      if (models.length > 0) {
        for (const tier of TIERS) {
          const route = tiers[tier]
          if (route !== undefined && !models.some(option => option.provider === route.provider && option.model === route.model)) {
            throw new BridgeError(400, 'bad-request', `unknown model route ${route.provider}/${route.model}`)
          }
        }
      }
      let manager = current.manager
      if ('manager' in body) {
        manager = body['manager'] === null ? undefined : normaliseManager(body['manager'])
        if (body['manager'] !== null && manager === undefined) {
          throw new BridgeError(400, 'bad-request', 'manager must be "strongest", "inherit", or a {provider, model} route')
        }
        const picked = manager
        if (typeof picked === 'object' && models.length > 0
          && !models.some(option => option.provider === picked.provider && option.model === picked.model)) {
          throw new BridgeError(400, 'bad-request', `unknown model route ${picked.provider}/${picked.model}`)
        }
      }
      await tierStore.set({ auto: incoming.auto, tiers, ...manager === undefined ? {} : { manager } })
      ctx.logger.info(`host-router: tier settings saved (auto=${String(incoming.auto)})`)
      return await tierFace.read()
    },
  }

  /** Level 1: explicit -> files -> unique keyword score -> LLM -> keyword fallback. */
  const route = async (input: { readonly text?: string; readonly partition?: string; readonly files?: readonly string[] }): Promise<RouteDecision> =>
    await resolveRouteSmart(partitions, input, {
      ...config.defaultPartition === undefined ? {} : { fallback: config.defaultPartition },
      ...classifier === undefined ? {} : { classifier },
      topDirs,
      ...config.autoRouteMinScore === undefined ? {} : { minScore: config.autoRouteMinScore },
      timeoutMs: classifierTimeout,
    })

  /**
   * The services this plugin reads, in the order it needs them.
   *
   * Reported once at activation so a version upgrade has one line to read: a
   * seam that vanished shows up as `absent` here instead of as a failure three
   * tasks later. `webServer` is checked separately — it can arrive after this
   * runs, and the `ctx.inject` below logs its own outcome.
   */
  const SEAMS = ['tools', 'subagents', 'agents', 'sessionQuery', 'credentials', 'sandboxPolicy'] as const
  /**
   * Whether one service is reachable.
   *
   * `ctx.get` is the safe lookup, but a service this plugin injects also exists
   * as a plain property, and the two do not always agree (a host may expose the
   * injected pair without making them retrievable by name). A report that says
   * `tools=absent` while the plugin is registering tools would be worse than no
   * report, so both spellings are tried.
   */
  const seamPresent = (name: string): boolean => {
    if (ctx.get(name) !== undefined) return true
    try {
      return (ctx as unknown as Record<string, unknown>)[name] !== undefined
    } catch {
      return false
    }
  }
  ctx.logger.info('host-router seams: ' + SEAMS
    .map(name => `${name}=${seamPresent(name) ? 'ok' : 'absent'}`)
    .join(' '))

  // The logger does not necessarily reach the process log (on a `dsh web`
  // service it is swallowed), so the same report also lands in a file an operator
  // can read after an upgrade: `<dsh home>/router/seams.json`.
  const seamReport: Record<string, boolean> = {}
  for (const name of SEAMS) seamReport[name] = seamPresent(name)
  /** Seams without which the plugin cannot dispatch anything at all. */
  const REQUIRED_SEAMS = ['tools', 'subagents'] as const
  await writeFile(join(boardDir, 'seams.json'), JSON.stringify({
    at: new Date().toISOString(),
    node: process.version,
    seams: seamReport,
    required: REQUIRED_SEAMS,
    ok: REQUIRED_SEAMS.every(name => seamReport[name] === true),
  }, undefined, 2), 'utf8').catch((error: unknown) => {
    ctx.logger.warn(`host-router: could not write seams.json: ${String(error)}`)
  })

  /** Partition layout problems, checked once at boot and shown on the workspace page. */
  const configProblems: readonly PartitionProblem[] = await partitionProblems(partitions).catch(() => [])
  for (const problem of configProblems) {
    ctx.logger.warn(`host-router: partition "${problem.partition}" ${problem.level}: ${problem.message}`)
  }

  let sequence = board.list().length
  /** Most recent human-facing agent, used when a queued task's own dispatcher is gone. */
  let lastCaller: LiveAgent | undefined
  /** Activations started by this process, keyed by task id. */
  const inFlight = new Map<string, SubagentActivation>()
  /** Partition names whose pump loop is running; prevents double dispatch. */
  const pumping = new Set<string>()
  /**
   * True once this process is shutting down (SIGTERM/SIGINT) or this plugin is
   * being disposed. A child that ends while it is set was stopped by the harness,
   * not by its own work, so its row becomes `interrupted` and is resumed from its
   * log on the next boot instead of being recorded as failed.
   */
  let stopping = false
  const markStopping = (): void => { stopping = true }
  process.once('SIGTERM', markStopping)
  process.once('SIGINT', markStopping)
  ctx.effect(() => () => {
    stopping = true
    process.off('SIGTERM', markStopping)
    process.off('SIGINT', markStopping)
  }, 'host-router: shutdown marker')

  const partitionOf = (task: RouterTask): Partition => {
    const found = partitions.find(entry => entry.name === task.partition)
    if (found === undefined) {
      throw new PartitionConfigError(`board references unknown partition "${task.partition}"`)
    }
    return found
  }

  /**
   * Whether a partition's operator switch is on.
   *
   * Absent means enabled, so a board written before this switch existed needs no
   * migration.
   */
  const isEnabled = (name: string): boolean => board.partitionRecord(name).disabled !== true

  const liveAgent = (id: string | undefined): LiveAgent | undefined => {
    if (id === undefined) return undefined
    return ctx.get('agents')?.get(id)
  }

  /**
   * The router's own long-lived Agent, created on first need.
   *
   * The board's demand composer posts over HTTP, so the request carries no
   * Agent, and a Harness sitting idle holds none either. The documented design
   * (see `PartitionConfig.manager`) is one long-lived manager that receives work
   * and decomposes it; this is that manager for the whole Router. Kept for the
   * plugin's lifetime so repeated demands reuse one Session instead of littering
   * the list with one root Agent per click.
   */
  /**
   * The router's chat-facing anchor Session, titled "作战室".
   *
   * It is an ordinary root Session the user can open in the Sidebar and talk
   * to; panel demands are posted into it as user messages, it dispatches with
   * `route_task`, and the managers it starts report back into it (delivery
   * `parent`). Its id persists in `<boardDir>/anchor.json`, so a restart resumes
   * the same conversation instead of starting a new one.
   */
  const anchorFile = join(boardDir, 'anchor.json')
  /** The anchor's session id: read from disk, or minted on first creation. */
  let anchorSessionId: string | undefined = await readFile(anchorFile, 'utf8')
    .then(text => (JSON.parse(text) as { sessionId?: unknown }).sessionId)
    .then(id => (typeof id === 'string' && id !== '' ? id : undefined))
    .catch(() => undefined)
  let anchorPending: Promise<LiveAgent | undefined> | undefined
  /** Agents (by object) that already carry the dispatcher instructions. */
  const instructed = new WeakSet<object>()

  /** Give one anchor Agent its dispatcher instructions as a per-agent system section. */
  const instructAnchor = (agent: LiveAgent): void => {
    if (instructed.has(agent)) return
    const prompt = (agent.ctx as { systemPrompt?: SystemPromptLike } | undefined)?.systemPrompt
    if (prompt === undefined || typeof prompt.section !== 'function') {
      ctx.logger.warn('router: anchor agent exposes no ctx.systemPrompt; dispatcher instructions not installed')
      return
    }
    try {
      prompt.section({
        name: 'router:anchor-dispatcher',
        // After the deployment persona suffix, so it is the last word.
        order: (prompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX') ?? 10_200) + 50,
        text: anchorInstructions(partitions),
      })
      instructed.add(agent)
    } catch (error) {
      ctx.logger.warn(`router: could not install anchor instructions: ${String(error)}`)
    }
  }

  // Whoever makes the anchor live — this plugin, or the session controller when
  // the user opens it from the Sidebar after a restart — it gets the same
  // instructions, so chatting there and posting from the panel behave alike.
  ctx.on('agent/created', ((payload: { readonly agent?: LiveAgent }) => {
    const agent = payload?.agent
    if (agent !== undefined && anchorSessionId !== undefined && agent.id === anchorSessionId) instructAnchor(agent)
  }) as never)

  const persistAnchor = async (sessionId: string): Promise<void> => {
    await writeFile(anchorFile, JSON.stringify({ sessionId, title: ANCHOR_TITLE, at: new Date().toISOString() }, undefined, 2), 'utf8')
      .catch((error: unknown) => { ctx.logger.warn(`router: could not persist ${anchorFile}: ${String(error)}`) })
  }

  const ensureAnchor = async (_cwd?: string): Promise<LiveAgent | undefined> => {
    const agents = ctx.get('agents')
    const create = agents?.create
    if (agents === undefined || create === undefined) return undefined
    if (anchorSessionId !== undefined) {
      const live = agents.get(anchorSessionId)
      if (live !== undefined) {
        instructAnchor(live)
        return live
      }
    }
    if (anchorPending !== undefined) return await anchorPending
    anchorPending = (async () => {
      try {
        const selection = ctx.get('agentDefaultModel')?.currentSelection()
        const agentOptions = selection === undefined
          ? undefined
          : {
            provider: selection.provider,
            model: selection.model,
            ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
          }
        const presets = ctx.get('agentPresets')
        let presetId: string | undefined
        if (presets !== undefined && defaultPreset !== undefined) {
          try {
            presetId = (await presets.resolve(defaultPreset)).id
          } catch (error) {
            ctx.logger.warn(`router: anchor preset "${defaultPreset}" unavailable, creating without one: ${String(error)}`)
          }
        }
        const setup = presets === undefined || presetId === undefined
          ? undefined
          : async (agentCtx: unknown) => { await presets.mount(agentCtx, presetId) }

        // 1. Resume the persisted conversation.
        if (anchorSessionId !== undefined && typeof agents.resume === 'function') {
          try {
            const handle = await agents.resume.call(agents, {
              resumeSessionId: anchorSessionId,
              ...(agentOptions === undefined ? {} : { agentOptions }),
              ...(setup === undefined ? {} : { setup }),
            })
            ctx.effect(() => () => { void handle.dispose() }, 'router: anchor agent')
            instructAnchor(handle.agent)
            ctx.logger.info(`router: resumed anchor session ${anchorSessionId}`)
            return handle.agent
          } catch (error) {
            // Someone else (the session controller) may have just made it live.
            const live = agents.get(anchorSessionId)
            if (live !== undefined) {
              instructAnchor(live)
              return live
            }
            ctx.logger.warn(`router: cannot resume anchor ${anchorSessionId}, creating a new one: ${String(error)}`)
          }
        }

        // 2. Create a new one.
        const sessionId = `session-${randomUUID()}`
        anchorSessionId = sessionId
        const handle = await create.call(agents, {
          sessionId,
          meta: { cwd: anchorDirOf(partitions), ...(presetId === undefined ? {} : { agentPreset: presetId }) },
          ...(setup === undefined ? {} : { setup }),
          ...(agentOptions === undefined ? {} : { agentOptions }),
        })
        ctx.effect(() => () => { void handle.dispose() }, 'router: anchor agent')
        instructAnchor(handle.agent)
        await persistAnchor(sessionId)
        const titles = ctx.get('sessionTitle') as { rename?(session: unknown, title: string): unknown } | undefined
        try {
          titles?.rename?.(handle.agent.session, ANCHOR_TITLE)
        } catch (error) {
          ctx.logger.warn(`router: could not title the anchor session: ${String(error)}`)
        }
        ctx.logger.info(`router: created anchor session ${sessionId}`)
        return handle.agent
      } catch (error) {
        ctx.logger.warn(`router: cannot create an anchor agent: ${String(error)}`)
        return undefined
      } finally {
        anchorPending = undefined
      }
    })()
    return await anchorPending
  }


  /**
   * Attach a demand that has no producing Agent to a live one.
   *
   * `startActivation` requires the exact live parent, so a demand posted from the
   * board — whose HTTP request carries no Agent at all — could never start: the
   * pump found no `dispatchFrom` owner, no tool-call caller and no `lastCaller`,
   * and returned while the row stayed queued forever.
   * @returns a live Agent, or undefined when the harness cannot provide one.
   */
  const anyLiveAgent = async (cwd: string): Promise<LiveAgent | undefined> => {
    const query = ctx.get('sessionQuery')
    const agents = ctx.get('agents')
    if (query !== undefined && agents !== undefined) {
      try {
        const records = await query.listSessions()
        for (const record of [...records].reverse()) {
          const agent = agents.get(record.id)
          if (agent !== undefined) return agent
        }
      } catch (error) {
        ctx.logger.warn(`router: cannot scan for a live agent: ${String(error)}`)
      }
    }
    return await ensureAnchor(cwd)
  }

  /**
   * Pick the parent for one queued row.
   *
   * Recorded owner first (a row keeps its producing Agent when that Agent is
   * still alive), then the current tool-call caller, then the last caller seen,
   * then any live Session, then the Router's own anchor.
   */
  const resolveParent = async (
    task: RouterTask,
    caller: LiveAgent | undefined,
  ): Promise<LiveAgent | undefined> => {
    // A row held back by its order starts after its dispatcher may have ended its
    // turn; the parent manager's own session is the next best owner, because the
    // worker's report must reach the manager that is waiting for it.
    const parentSession = task.parentId === undefined ? undefined : board.get(task.parentId)?.sessionId
    const recorded = liveAgent(task.dispatchFrom) ?? liveAgent(parentSession) ?? caller ?? lastCaller
    if (recorded !== undefined) return recorded
    const root = partitions.find(entry => entry.name === task.partition)?.dir
    return await anyLiveAgent(root ?? process.cwd())
  }

  /** A row occupies a slot only while a real child could still be running. */
  const holdsSlot = (task: RouterTask): boolean => {
    if (task.state !== 'running' && task.state !== 'dispatched') return false
    return inFlight.has(task.id) || liveAgent(task.sessionId) !== undefined
  }

  /** Workers, not managers: managers are control entities with their own cap. */
  const runningCount = (partition: string): number =>
    board.inPartition(partition).filter(task => task.level === 'worker' && holdsSlot(task)).length

  /** Workspace workers only: a 快任务 worker has its own slots and never takes a workspace's. */
  const totalRunning = (): number =>
    board.list().filter(task => task.level === 'worker' && !quickNames.has(task.partition) && holdsSlot(task)).length

  /** Whether the router-side worker caps are reached; `0` means that cap is off. */
  const workersFull = (partition: Partition): boolean =>
    (maxWorkers > 0 && partition.quick !== true && totalRunning() >= maxWorkers)
    || (partition.slots > 0 && runningCount(partition.name) >= partition.slots)

  const readLog = createLogReader(ctx.get('sessionQuery'), ctx.logger)

  /**
   * Why a session must not receive more work, or undefined when it may.
   *
   * The ceiling is prompt-side tokens of the session's own last request, read
   * from its durable log through the same short-TTL cache the snapshot uses, so
   * a guard at dispatch time does not become a full log read per call.
   *
   * An unknown count (a fresh child, or a provider that reports no usage) counts
   * as under the ceiling: refusing on missing evidence would strand every task
   * on a deployment whose model omits usage, and the guard exists to stop known
   * bloat, not to gate on instrumentation.
   * @param sessionId - session that would receive the work.
   * @param role - how to name that session in the refusal, e.g. `this session`.
   * @returns the refusal sentence, or undefined when the attach is allowed.
   */
  const attachRefusal = async (sessionId: string, role: string): Promise<string | undefined> => {
    if (contextLimit <= 0) return undefined
    const used = pressureTokensOf(await readLog(sessionId))
    if (used === undefined || used <= contextLimit) return undefined
    return `${role} is at ${formatTokens(used)} prompt tokens, past the ${formatTokens(contextLimit)} `
      + 'attach ceiling. Another turn there would re-read more history than it can still reason over, '
      + 'so the router does not hand it more work.'
  }

  /**
   * Rebuild the one UI document and persist it. Concurrent callers (several
   * open panels, SSE refreshes) share the build already in flight instead of
   * each starting a full pass over every worker log.
   */
  // A caller that arrives mid-build may have just changed the board, so it
  // waits for one follow-up build rather than the stale one; all callers that
  // arrive during the same build share that single follow-up.
  let snapshotInFlight: Promise<RouterSnapshot> | undefined
  let snapshotQueued: Promise<RouterSnapshot> | undefined
  const startSnapshot = (): Promise<RouterSnapshot> => {
    const run = buildAndWriteSnapshot().finally(() => {
      if (snapshotInFlight === run) snapshotInFlight = undefined
    })
    snapshotInFlight = run
    return run
  }
  const publishSnapshot = (): Promise<RouterSnapshot> => {
    if (snapshotInFlight === undefined) return startSnapshot()
    if (snapshotQueued === undefined) {
      snapshotQueued = snapshotInFlight.catch(() => undefined).then(() => {
        snapshotQueued = undefined
        return startSnapshot()
      })
    }
    return snapshotQueued
  }
  /** Set when a snapshot pass settled a row from its log; the queue is driven after the pass. */
  let settledFromLog = false
  const buildAndWriteSnapshot = async (): Promise<RouterSnapshot> => {
    const byId = new Map(board.list().map(row => [row.id, row]))
    const snapshot = await buildSnapshot({
      progress: () => progressOf(),
      notices: () => recentNotices,
      waitingFor: (task) => {
        const gate = orderGate(task)
        return gate.kind === 'wait' ? gate.on : undefined
      },
      rootOf: (task) => rootOf(task, byId).id,
      board,
      partitions,
      sessionQuery: ctx.get('sessionQuery'),
      logger: ctx.logger,
      isLive: task => holdsSlot(task),
      readLog,
      correctState: async (task, change) => {
        if (task.level === 'manager' && change.state === 'done' && await keepManagerWaiting(task, change.result ?? '')) return
        settledFromLog = true
        await board.patch(task.id, {
          state: change.state,
          ...change.result === undefined ? {} : { result: tail(change.result) },
          ...change.error === undefined ? {} : { error: change.error },
        })
      },
    })
    if (settledFromLog) {
      settledFromLog = false
      // Off the build: driving the queue publishes again, which waits on this one.
      setTimeout(() => { void afterChange().catch(() => {}) }, 0)
    }
    try {
      await mkdir(dirname(snapshotPath), { recursive: true })
      await writeFile(snapshotPath, JSON.stringify(snapshot, undefined, 2), 'utf8')
    } catch (error) {
      ctx.logger.warn(`host-router: could not write ${snapshotPath}: ${String(error)}`)
    }
    return snapshot
  }

  /** Record a task's terminal state from the worker's own result, then drive what it unblocks. */
  const finish = async (
    taskId: string,
    result: { readonly stopReason: string; readonly output: readonly ContentBlock[] },
  ): Promise<void> => {
    await settleRow(taskId, result)
    await afterChange().catch((error: unknown) => {
      ctx.logger.warn(`host-router: after settling ${taskId}: ${String(error)}`)
    })
  }

  /** Record a task's terminal state from the worker's own result. */
  const settleRow = async (
    taskId: string,
    result: { readonly stopReason: string; readonly output: readonly ContentBlock[] },
  ): Promise<void> => {
    inFlight.delete(taskId)
    const task = board.get(taskId)
    if (task === undefined || (task.state !== 'running' && task.state !== 'dispatched')) return
    const partition = partitionOf(task)
    const report = textOf(result.output)
    // Parsed before the state branch on purpose: a worker that died still changed
    // files, and the decision about reusing this session needs that too.
    const facts = parseWorkerReport(report)
    const described: Partial<RouterTask> = facts === undefined
      ? {}
      : {
          ...facts.summary === undefined ? {} : { summary: facts.summary },
          touched: facts.touched,
          ...facts.left === undefined ? {} : { left: facts.left },
        }
    if (result.stopReason !== 'completed' && stopping && task.sessionId !== undefined) {
      // Stopped by the harness, not by the work: keep it resumable.
      await board.patch(taskId, { state: 'interrupted', error: INTERRUPTED_NOTE, ...described })
      return
    }
    if (result.stopReason !== 'completed') {
      await board.patch(taskId, {
        state: 'failed',
        result: tail(report),
        error: `worker ended with stopReason "${result.stopReason}"`,
        ...described,
      })
      await publishSnapshot().catch(() => {})
      return
    }
    if (task.level === 'manager') {
      // Level 2 contract: a manager dispatches, it does not execute.
      const children = board.childrenOf(task.id)
      if (children.length === 0) {
        await board.patch(taskId, {
          state: 'failed',
          result: tail(report),
          error: 'manager dispatched no worker',
          ...described,
        })
        await publishSnapshot().catch(() => {})
        return
      }
      // A manager that ends while some of its tasks are still waiting (on a stage,
      // a prerequisite, or a suspension) would lose their reports: wake it to wait.
      if (await keepManagerWaiting(task, report)) return
      // No acceptance step: a manager that dispatched and ended normally is done.
      const relayed = relayWarning(task.body, children)
      if (relayed !== undefined) ctx.logger.warn(`host-router: ${taskId} ${relayed}`)
      const managerResult = relayed === undefined ? tail(report) : `${tail(report)}\n\n[router] ${relayed}`
      await board.patch(taskId, { state: 'done', result: managerResult, ...described })
      await publishSnapshot().catch(() => {})
      return
    }
    const commands = task.verify ?? (autoVerify ? partition.verify ?? [] : [])
    if (commands.length === 0) {
      // No acceptance command configured: a normal end is finished.
      await board.patch(taskId, { state: 'done', result: tail(report), ...described })
      await publishSnapshot().catch(() => {})
      return
    }
    const verdict = await runVerify(commands, partition.dir, verifyTimeout)
    await board.patch(taskId, {
      state: verdict.ok ? 'verified' : 'failed',
      result: tail(report),
      verify: commands,
      verifyOutput: tail(verdict.output),
      ...verdict.ok ? {} : { error: `acceptance failed: ${verdict.failed ?? 'unknown command'}` },
      ...described,
    })
    await publishSnapshot().catch(() => {})
  }

  /** Record a start failure without pretending the task ran. */
  const failStart = async (taskId: string, error: unknown): Promise<void> => {
    inFlight.delete(taskId)
    const message = error instanceof Error ? error.message : String(error)
    if (board.get(taskId) === undefined) return
    await board.patch(taskId, { state: 'failed', error: `dispatch failed: ${message}` })
    await publishSnapshot().catch(() => {})
  }

  /**
   * Start one child for one task and wire its settlement.
   *
   * The parent is re-resolved by the caller rather than captured at enqueue time:
   * a queued task can be pumped minutes later, after the agent that queued it
   * settled and was disposed, and `startActivation` requires the exact live
   * parent.
   */
  const dispatch = async (task: RouterTask, parent: LiveAgent): Promise<void> => {
    const partition = partitionOf(task)
    const isManager = task.level === 'manager'
    let brief: string | undefined
    if (isManager) {
      try {
        brief = memoryBrief(await memory.read(partition.name), board.inPartition(partition.name))
      } catch (error) {
        ctx.logger.warn(`host-router: ${partition.name} memory unavailable for ${task.id}: ${String(error)}`)
      }
    }
    const prompt = isManager
      ? managerPrompt({ partition, taskId: task.id, body: task.body, contextLimit, ...brief === undefined ? {} : { memory: brief } })
      : workerPrompt(partition, task.id, task.body, autoVerify)
    const label = `${partition.name}/${isManager ? 'manager' : 'worker'}: ${task.subject}`
    // Tier -> model route, read at dispatch time so a saved change applies to queued rows too.
    let route: TierRoute | undefined
    let managerSource: string | undefined
    if (isManager) {
      // A manager plans for the whole partition: it runs on the strongest model by default.
      try {
        const chosen = await managerRoute()
        route = chosen.route
        managerSource = chosen.source
      } catch (error) {
        ctx.logger.warn(`host-router: manager route for ${task.id} unavailable: ${String(error)}`)
      }
    } else if (task.routeOverride !== undefined) {
      // A human picked the model (改派 / 换模型重跑).
      route = { ...task.routeOverride }
    } else if (task.tier !== undefined && (tierStore.get().auto || task.tierSource === 'explicit')) {
      try {
        route = (await effectiveTiers())[task.tier]
      } catch (error) {
        ctx.logger.warn(`host-router: tier route for ${task.id} unavailable: ${String(error)}`)
      }
    }
    try {
      const startSpec = {
        cwd: partition.dir,
        prompt,
        provider,
        parent,
        // The tool call's signal owns startup only. The child keeps running after
        // the call returns, so what the router keeps is the activation handle.
        signal: new AbortController().signal,
        label,
        ...presetOf(partition) === undefined ? {} : { preset: presetOf(partition)! },
        maxDepth,
        // Every child reports to its parent, including the anchor: the anchor is
        // the chat the user reads, and the manager's report is what it relays.
        delivery: 'parent' as const,
      }
      let activation: SubagentActivation
      let usedRoute = route
      try {
        activation = await startWorker(ctx.get('subagents')!, {
          ...startSpec,
          ...route === undefined ? {} : { agentOptions: route },
        })
      } catch (error) {
        if (route === undefined) throw error
        // A route the runtime rejects must not lose the task: fall back to inheriting.
        ctx.logger.warn(`host-router: ${task.id} could not start on ${route.provider}/${route.model}, inheriting: ${String(error)}`)
        usedRoute = undefined
        activation = await startWorker(ctx.get('subagents')!, startSpec)
      }
      inFlight.set(task.id, activation)
      const parentRoute = (parent.session as { requestHeader?: () => { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined })
        .requestHeader?.()?.config
      const recorded = usedRoute ?? (parentRoute?.provider !== undefined && parentRoute.model !== undefined
        ? { provider: parentRoute.provider, model: parentRoute.model, ...parentRoute.reasoningEffort === undefined ? {} : { reasoningEffort: parentRoute.reasoningEffort } }
        : undefined)
      await board.patch(task.id, {
        ...recorded === undefined ? {} : { provider: recorded.provider, model: recorded.model },
        ...recorded?.reasoningEffort === undefined ? {} : { reasoningEffort: recorded.reasoningEffort },
        ...route !== undefined && usedRoute === undefined ? { tierReason: `${task.tierReason ?? ''} (route rejected, inherited)` } : {},
        ...managerSource !== undefined
          ? { tierSource: 'manager', tierReason: `manager model: ${managerSource}${route !== undefined && usedRoute === undefined ? ' (route rejected, inherited)' : ''}` }
          : task.tier === undefined ? { tierSource: 'off' } : {},
      })
      await board.patch(task.id, {
        state: 'dispatched',
        sessionId: activation.childId,
        worker: activation.name,
        dispatchFrom: parent.id,
        reportedTo: parent.id,
        attempts: task.attempts + 1,
        runToken,
      })
      void activation.result.then(
        result => finish(task.id, result).catch((error: unknown) => {
          ctx.logger.warn(`host-router: closing ${task.id} failed: ${String(error)}`)
        }),
        (error: unknown) => failStart(task.id, error).catch(() => {}),
      )
      // In 0.2.2-rc.3 the sandbox's write boundary is `session.header.cwd`, and a
      // child inherits its creator's header cwd — so a worker rooted in another
      // partition needs an explicit write grant. Best effort: the grant is
      // runtime-only (re-registered on every dispatch) and, on Windows, covers
      // harness file tools rather than sandboxed processes. A deployment that
      // needs the guarantee should also set `additionalWritableRoots`.
      const sandboxPolicy = ctx.get('sandboxPolicy')
      if (sandboxPolicy !== undefined) {
        const child = ctx.get('agents')?.get(activation.childId)
        if (child !== undefined) {
          try {
            sandboxPolicy.registerWritableRoot(child.session, partition.dir)
          } catch (error) {
            ctx.logger.warn(`host-router: could not grant ${partition.dir} to ${activation.childId}: ${String(error)}`)
          }
        }
      }
      if (isManager) {
        await board.patchPartition(partition.name, {
          managerSessionId: activation.childId,
          managerName: activation.name,
          managerUpdatedAt: new Date().toISOString(),
        })
      }
    } catch (error) {
      await failStart(task.id, error)
    }
  }

  /**
   * Start queued tasks while the partition has free slots.
   *
   * Not a background timer on purpose: the pump runs on enqueue and on the tool
   * calls that read the board, so an idle harness holds no scheduled work and a
   * human action is what re-drives a queue left behind by a restart.
   */
  const pump = async (partitionName: string, caller: LiveAgent | undefined): Promise<void> => {
    if (pumping.has(partitionName)) return
    pumping.add(partitionName)
    try {
      while (true) {
        const partition = partitions.find(entry => entry.name === partitionName)
        if (partition === undefined) return
        // A disabled partition accepts no new demand and starts nothing; its
        // existing rows keep the state they already reached.
        if (!isEnabled(partitionName)) return
        // Managers are control entities: any number may run at once, one per
        // demand. Only workers count against the (optional) caps.
        const full = workersFull(partition)
        let next: RouterTask | undefined
        for (const task of board.inPartition(partitionName)) {
          if (task.state !== 'queued' || (task.level !== 'manager' && full)) continue
          // Order: a row whose prerequisites are open waits; one whose
          // prerequisite can never finish is parked for a human.
          const gate = orderGate(task)
          if (gate.kind === 'wait') continue
          if (gate.kind === 'dead') {
            await board.patch(task.id, {
              state: 'blocked',
              resumeNote: `${gate.reason}；重试那个前置任务后这里会自动继续，或用 resume 跳过前置直接开始`,
              waitingOn: gate.on,
              blockedFrom: 'queued',
            })
            notice(`任务 ${task.id}（${task.subject}）没法开始：${gate.reason}。已暂停等你决定。`, task)
            continue
          }
          next = task
          break
        }
        if (next === undefined) return
        if ((next.dependsOn?.length ?? 0) > 0 || next.stage !== undefined) startedAfterOrder.push(next)
        const parent = await resolveParent(next, caller)
        if (parent === undefined) return
        await dispatch(next, parent)
      }
    } finally {
      pumping.delete(partitionName)
    }
  }

  /** Create one task row and persist it before anything is dispatched. */
  const enqueue = async (
    input: RouteArgs,
    decision: { readonly partition: Partition; readonly reason: RouteReason; readonly because: readonly string[] },
    level: 'manager' | 'worker',
    caller: LiveAgent | undefined,
    tier?: TierDecision,
  ): Promise<RouterTask> => {
    const now = new Date().toISOString()
    const task: RouterTask = {
      id: nextTaskId(sequence++),
      partition: decision.partition.name,
      ...input.parent_task === undefined ? {} : { parentId: input.parent_task },
      subject: input.subject ?? input.text.replace(/\s+/g, ' ').slice(0, 72),
      body: input.text,
      state: 'queued',
      cwd: decision.partition.dir,
      priority: input.priority ?? 0,
      level,
      reason: decision.reason,
      because: decision.because,
      ...caller === undefined ? {} : { dispatchFrom: caller.id },
      ...input.verify === undefined ? {} : { verify: input.verify },
      ...tier === undefined ? {} : { tier: tier.tier, tierSource: tier.source, tierReason: tier.reason },
      ...input.depends_on === undefined || input.depends_on.length === 0 ? {} : { dependsOn: [...new Set(input.depends_on)] },
      ...input.stage === undefined ? {} : { stage: input.stage },
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    return await board.add(task)
  }

  // --- Order, suspension and progress notices ---------------------------------
  //
  // The pump starts a queued row only when its order allows (order.ts). Anything
  // that can unblock a row — a worker settling, a log fold that closed a resumed
  // row, a human retry — ends in `afterChange`, which re-drives every partition,
  // wakes suspended rows whose prerequisites finished, and tells the 作战室 how
  // the request is doing.

  const READY: Gate = { kind: 'ready' }
  /** Whether one queued row may start now. A human `resume` sets `ignoreOrder`. */
  const orderGate = (task: RouterTask): Gate => task.ignoreOrder === true ? READY : gateOf(task, board.list())
  /** Rows the current pump pass started after waiting on their order; announced by `afterChange`. */
  const startedAfterOrder: RouterTask[] = []
  /** Most woken-to-wait cycles one manager gets before it is closed anyway. */
  const MAX_REWAKES = 4
  /** States in which a manager's task is still going to produce a report. */
  const stillComing = (state: TaskState): boolean =>
    state === 'queued' || state === 'dispatched' || state === 'running' || state === 'interrupted' || state === 'suspended'

  /** Progress per request (root task), for the snapshot and the notices. */
  const progressOf = (): readonly GroupProgress[] => groupProgress(board.list())
  const groupLineOf = (task: RouterTask): string => {
    const byId = new Map(board.list().map(row => [row.id, row]))
    const root = rootOf(task, byId)
    const group = progressOf().find(entry => entry.rootId === root.id)
    return group === undefined ? '' : `「${root.subject}」整体：${progressLine(group)}。`
  }

  // Notices are coalesced: several changes in a few seconds become one message,
  // so a stage of six workers finishing does not post six times.
  const noticesEnabled = config.progressNotices !== false
  const NOTICE_DEBOUNCE_MS = config.progressNoticeDelayMs ?? 3_000
  const pendingNotices: string[] = []
  /** Last notices, newest first, for the panel. */
  let recentNotices: readonly { readonly at: string; readonly text: string }[] = []
  let noticeTimer: ReturnType<typeof setTimeout> | undefined
  const flushNotices = async (): Promise<void> => {
    noticeTimer = undefined
    if (pendingNotices.length === 0) return
    const lines = pendingNotices.splice(0, pendingNotices.length)
    const agent = liveAgent(anchorSessionId) ?? await ensureAnchor().catch(() => undefined)
    if (agent === undefined || typeof agent.followup !== 'function') return
    try {
      agent.followup(userMessage(['【进度提醒】', ...lines.map(line => `- ${line}`)].join('\n')))
    } catch (error) {
      ctx.logger.warn(`host-router: progress notice not delivered: ${String(error)}`)
    }
  }
  /**
   * Queue one line for the 作战室 and the panel's notice list.
   * @param text - one sentence for a person.
   * @param about - the row it is about; its request's progress is appended.
   */
  const notice = (text: string, about?: RouterTask): void => {
    const line = about === undefined ? text : `${text}${groupLineOf(about)}`
    recentNotices = [{ at: new Date().toISOString(), text: line }, ...recentNotices].slice(0, 30)
    ctx.logger.info(`host-router notice: ${line}`)
    if (!noticesEnabled) return
    pendingNotices.push(line)
    if (noticeTimer === undefined) {
      noticeTimer = setTimeout(() => { void flushNotices() }, NOTICE_DEBOUNCE_MS)
      noticeTimer.unref?.()
    }
  }
  ctx.effect(() => () => { if (noticeTimer !== undefined) clearTimeout(noticeTimer) }, 'host-router: notice timer')

  /**
   * Keep a manager in its role while some of its tasks are still to come.
   *
   * A manager that ends its turn while children wait on a stage, a prerequisite
   * or a suspension would never see their reports. Instead of closing it, the
   * router continues the manager's own session with the list of what is still
   * open and tells it to wait (`task_wait`), at most `MAX_REWAKES` times.
   * @returns true when the manager was woken (the row stays `running`).
   */
  const keepManagerWaiting = async (task: RouterTask, report: string): Promise<boolean> => {
    if (task.level !== 'manager' || task.sessionId === undefined) return false
    const open = board.childrenOf(task.id).filter(child => stillComing(child.state))
    if (open.length === 0) return false
    const rewakes = (task.rewakes ?? 0) + 1
    if (rewakes > MAX_REWAKES) return false
    const sender = liveAgent(task.dispatchFrom) ?? await ensureAnchor().catch(() => undefined)
    if (sender === undefined) return false
    const text = [
      `【系统通知】你还有 ${String(open.length)} 个子任务没有结束，现在不能汇总：`,
      ...open.map(child => `- ${child.id} ${child.subject}：${child.state === 'suspended' ? '挂起中' : child.state === 'queued' ? '排队等前置' : '进行中'}`),
      `它们会在前置完成后自动开始。请调用 \`task_wait\`（parent_task 填 "${task.id}"）等它们，必要时配合 \`wait_agent\`，`,
      '全部结束后再给出完整的汇总报告。不要重复派发这些任务。',
    ].join('\n')
    try {
      await continueWorker(ctx.get('subagents')!, sender, task.sessionId, text, AbortSignal.timeout(60_000))
    } catch (error) {
      ctx.logger.warn(`host-router: could not wake manager ${task.id} to wait: ${String(error)}`)
      return false
    }
    await board.patch(task.id, {
      state: 'running', rewakes, runToken, reportedTo: sender.id,
      ...report.trim() === '' ? {} : { result: tail(report) },
    })
    resumedRows.add(task.id)
    watchResumed()
    ctx.logger.info(`host-router: manager ${task.id} ended with ${String(open.length)} open task(s); woken to wait (${String(rewakes)})`)
    return true
  }

  /** Who delivers a continuation into one row's session. */
  const senderFor = async (task: RouterTask): Promise<LiveAgent | undefined> => {
    const parentSession = task.parentId === undefined ? undefined : board.get(task.parentId)?.sessionId
    return liveAgent(task.dispatchFrom) ?? liveAgent(parentSession) ?? await ensureAnchor().catch(() => undefined)
  }

  /** Text a suspended worker receives when it may continue. */
  const wakeText = (task: RouterTask, manual: string | undefined): string => {
    const prereqs = (task.waitingOn ?? []).flatMap((id) => {
      const row = board.get(id)
      if (row === undefined) return []
      const said = row.summary ?? row.result
      return [`- ${row.id} ${row.subject}（${row.state}）${said === undefined ? '' : `：${tail(said.replace(/\s+/g, ' '), 400)}`}`]
    })
    const finishedBefore = task.suspendedFrom !== undefined && isFinished(task.suspendedFrom)
    return [
      '【系统通知】你之前挂起的任务现在可以继续了。你的会话历史和 todo 列表都还在。',
      `挂起原因：${task.suspendReason ?? '(无)'}`,
      ...prereqs.length === 0 ? [] : ['前置任务的结果：', ...prereqs],
      ...manual === undefined ? [] : [`人工说明：${manual}`],
      finishedBefore
        ? '这个任务之前已经交付过一次。请补上挂起时说的缺口，然后重新给出完整报告（含 --- report --- 块）。'
        : '请从挂起的那一步继续，已经完成的步骤不要重做，完成后照常给出报告。',
    ].join('\n')
  }

  /**
   * Continue one suspended (or dependency-blocked) row in its own session.
   * A row that never had a session goes back to the queue instead.
   */
  const wakeRow = async (task: RouterTask, manual?: string): Promise<string> => {
    if (task.sessionId === undefined) {
      await board.patch(task.id, { state: 'queued', waitingOn: [] })
      await pump(task.partition, undefined)
      return `${task.id}: back in the queue`
    }
    const sender = await senderFor(task)
    if (sender === undefined) throw new Error(`no live agent can deliver the wake-up of ${task.id}`)
    await continueWorker(ctx.get('subagents')!, sender, task.sessionId, wakeText(task, manual), AbortSignal.timeout(60_000))
    await board.patch(task.id, { state: 'running', waitingOn: [], runToken, reportedTo: sender.id })
    resumedRows.add(task.id)
    watchResumed()
    return `${task.id}: continued in session ${task.sessionId}`
  }

  /**
   * Suspend one task until other tasks finish.
   *
   * Works on any row a human may want to finish later — one in flight (its
   * worker is stopped unless it is the worker suspending itself), one waiting,
   * or one already delivered that turned out to need a prerequisite.
   */
  const suspendTask = async (input: {
    readonly taskId: string
    readonly reason: string
    readonly prerequisite?: string
    readonly partition?: string
    readonly waitFor?: readonly string[]
    readonly caller?: LiveAgent
  }): Promise<{ text: string; task: RouterTask; created?: RouterTask }> => {
    const task = board.get(input.taskId)
    if (task === undefined) throw new Error(`unknown task "${input.taskId}"`)
    if (task.state === 'cancelled') throw new Error(`${task.id} is cancelled; retry it instead of suspending it`)
    const reason = input.reason.trim() === '' ? '(未说明原因)' : input.reason.trim()
    const waitFor = [...new Set(input.waitFor ?? [])].filter(id => id !== task.id)
    const bad = dependencyError(waitFor, board.list())
    if (bad !== undefined) throw new Error(bad.replace('depends_on', 'wait_for'))
    let created: RouterTask | undefined
    if (input.prerequisite !== undefined && input.prerequisite.trim() !== '') {
      const decision = await route({
        text: input.prerequisite,
        partition: input.partition ?? task.partition,
      })
      if (!isEnabled(decision.partition.name)) throw new Error(`partition "${decision.partition.name}" is disabled`)
      const underParent = task.parentId !== undefined
      const level = decision.partition.managerEnabled && !underParent ? 'manager' : 'worker'
      const dispatcher = liveAgent(task.dispatchFrom) ?? input.caller
      created = await enqueue({
        text: input.prerequisite.trim(),
        subject: `前置：${input.prerequisite.replace(/\s+/g, ' ').trim().slice(0, 60)}`,
        priority: task.priority + 1,
        ...task.parentId === undefined ? {} : { parent_task: task.parentId },
      }, decision, level, dispatcher)
      if (task.dispatchFrom !== undefined && created.dispatchFrom === undefined) {
        created = await board.patch(created.id, { dispatchFrom: task.dispatchFrom })
      }
      waitFor.push(created.id)
    }
    const wasInFlight = task.state === 'running' || task.state === 'dispatched'
    const selfSuspend = input.caller !== undefined && task.sessionId !== undefined && input.caller.id === task.sessionId
    const updated = await board.patch(task.id, {
      state: 'suspended',
      suspendReason: reason,
      waitingOn: waitFor,
      suspends: (task.suspends ?? 0) + 1,
      suspendedFrom: task.state === 'suspended' ? (task.suspendedFrom ?? 'queued') : task.state,
    })
    // A human (or the chat) suspending a live worker stops it, as `block` does;
    // a worker suspending itself just ends its turn, so its tool call finishes.
    const sessionId = inFlight.get(task.id)?.childId ?? task.sessionId
    if (wasInFlight && !selfSuspend && sessionId !== undefined) {
      try {
        cancelWorker(ctx.get('subagents')!, sessionId)
      } catch (error) {
        ctx.logger.warn(`host-router: suspending ${task.id}: interrupt ${sessionId} failed: ${String(error)}`)
      }
    }
    if (created !== undefined) await pump(created.partition, input.caller ?? liveAgent(task.dispatchFrom))
    if (wasInFlight) await pump(task.partition, input.caller).catch(() => {})
    const waits = waitFor.length === 0 ? '没有指定前置，需要手动继续' : `等待 ${waitFor.join('、')}`
    notice(`任务 ${task.id}（${task.subject}）已挂起：${reason}；${waits}${created === undefined ? '' : `（已新建前置任务 ${created.id}）`}。`, task)
    await publishSnapshot().catch(() => {})
    // If everything it waits for is already finished, continue right away.
    await afterChange().catch(() => {})
    const after = board.get(task.id) ?? updated
    return {
      task: after,
      ...created === undefined ? {} : { created },
      text: [
        `${task.id} suspended (${waits}).`,
        created === undefined ? '' : `Prerequisite ${created.id} created in partition "${created.partition}" (state ${board.get(created.id)?.state ?? created.state}).`,
        selfSuspend
          ? 'End your turn now without doing more work: the router continues this same session, with the prerequisite\'s result, once it is done.'
          : after.state === 'suspended'
            ? 'It continues in its own session once every prerequisite is done; `task_control resume` continues it earlier.'
            : `Its prerequisites were already done, so it is ${after.state} again.`,
      ].filter(line => line !== '').join('\n'),
    }
  }

  /**
   * Re-drive everything an earlier change may have unblocked.
   *
   * Serialized: settlements arrive concurrently, and two passes waking the same
   * suspended row would send it the same message twice.
   */
  let changeChain: Promise<void> = Promise.resolve()
  const afterChange = (): Promise<void> => {
    const run = changeChain.then(async () => {
      const all = board.list()
      const listBefore = all
      const noticesBefore = recentNotices
      // 1. Rows parked because a prerequisite failed: a retried prerequisite may be done or running again.
      for (const task of all) {
        if (task.state !== 'blocked' || task.blockedFrom === undefined || (task.waitingOn?.length ?? 0) === 0) continue
        const gate = gateOfIds(task.waitingOn!, board.list())
        if (gate.kind === 'dead') continue
        if (task.blockedFrom === 'queued') {
          await board.patch(task.id, { state: 'queued', waitingOn: [] })
        } else {
          await board.patch(task.id, { state: 'suspended' })
        }
      }
      // 2. Suspended rows whose prerequisites are all finished continue; dead ones are parked.
      for (const task of board.list()) {
        if (task.state !== 'suspended' || (task.waitingOn?.length ?? 0) === 0) continue
        const gate = gateOfIds(task.waitingOn!, board.list())
        if (gate.kind === 'wait') continue
        if (gate.kind === 'dead') {
          await board.patch(task.id, {
            state: 'blocked',
            resumeNote: `${gate.reason}；重试那个前置任务后会自动继续，或用 resume 直接继续`,
            blockedFrom: 'suspended',
          })
          notice(`挂起的任务 ${task.id}（${task.subject}）没法继续：${gate.reason}。已暂停等你决定。`, task)
          continue
        }
        try {
          ctx.logger.info(`host-router: ${await wakeRow(task)}`)
          notice(`前置任务已完成，挂起的任务 ${task.id}（${task.subject}）继续执行。`, task)
        } catch (error) {
          await board.patch(task.id, { state: 'blocked', waitingOn: [], resumeNote: `前置已完成，但没法继续原会话：${String(error)}；用 retry 开一个新的执行者` })
          notice(`挂起的任务 ${task.id}（${task.subject}）的前置已完成，但没能继续原会话，需要你决定。`, task)
        }
      }
      // 3. Start whatever is now allowed to start.
      startedAfterOrder.length = 0
      for (const partition of partitions) await pump(partition.name, undefined).catch(() => {})
      const started = startedAfterOrder.splice(0, startedAfterOrder.length)
      if (started.length > 0) {
        notice(`前置任务完成，开始下一步：${started.map(task => `${task.id}（${task.subject}）`).join('、')}。`, started[0])
      }
      // Anything this pass changed (a wake, a park, a start, a notice) must reach the panel.
      if (recentNotices !== noticesBefore || board.list() !== listBefore) await publishSnapshot().catch(() => {})
    })
    changeChain = run.catch(() => {})
    return run
  }

  // --- Panel-side writes (the HTTP bridge calls these) -----------------------
  //
  // The three operations below are the same ones the tools expose, expressed
  // with a caller that has no agent behind it: a browser. Where a tool call may
  // assume a live agent, these must not.

  /**
   * Post demand texts from the panel into the anchor ("作战室") conversation.
   *
   * The panel no longer routes or enqueues anything itself: each text becomes
   * one user message in the anchor Session, exactly as if the user had typed it
   * there, and the anchor decides whether to answer directly or dispatch with
   * `route_task`. Several lines are joined into one message so the anchor sees
   * the request whole.
   */
  const publishDemands = async (texts: readonly string[]): Promise<PublishResult> => {
    const lines = texts.map(text => text.trim()).filter(text => text !== '')
    if (lines.length === 0) return { accepted: 0, routed: [] }
    const agent = await ensureAnchor()
    if (agent === undefined || typeof agent.followup !== 'function') {
      throw new BridgeError(503, 'unavailable', 'the 作战室 anchor session could not be started')
    }
    const text = lines.join('\n')
    agent.followup(userMessage(text))
    return {
      accepted: lines.length,
      routed: lines.map(line => ({ text: line, reason: `posted to ${ANCHOR_TITLE}` })),
      anchorSessionId: agent.id,
    }
  }

  /** The anchor's session id, creating or resuming it when needed (the panel's "open" button). */
  const anchorSession = async (): Promise<{ sessionId: string; title: string }> => {
    const agent = await ensureAnchor()
    if (agent === undefined) throw new BridgeError(503, 'unavailable', 'the 作战室 anchor session could not be started')
    return { sessionId: agent.id, title: ANCHOR_TITLE }
  }

  /**
   * Record a human verification decision on a reported task.
   *
   * Only `reported` is judgeable. That is the whole discipline of this board in
   * one line: a worker's claim is never advanced by anything except a separate
   * verdict, and a verdict is never re-opened by a later one.
   *
   * `verified` accepts. `rejected` closes the row as `failed` with the operator's
   * reason attached — the router does not silently re-queue it, because "send it
   * back" and "run it again" are different decisions and only the second one
   * spends another worker session.
   */
  const decideFromPanel = async (
    taskId: string,
    verdict: 'verified' | 'rejected',
    note: string | undefined,
  ): Promise<{ id: string; state: TaskState }> => {
    const task = board.get(taskId)
    if (task === undefined) throw new BridgeError(404, 'not-found', `unknown task "${taskId}"`)
    if (task.state !== 'reported') {
      throw new BridgeError(
        409,
        'conflict',
        `${task.id} is "${task.state}"; only a task awaiting verification ("reported") can be judged`,
      )
    }
    const stamp = new Date().toISOString()
    const remark = note === undefined || note.trim() === '' ? undefined : note.trim()
    const notes = [...task.notes ?? []]
    if (verdict === 'verified') {
      notes.push(`verified from the router panel at ${stamp}${remark === undefined ? '' : `: ${remark}`}`)
      const updated = await board.patch(task.id, { state: 'verified', notes })
      await publishSnapshot().catch(() => {})
      return { id: updated.id, state: updated.state }
    }
    const reason = remark ?? 'no reason given'
    notes.push(`rejected from the router panel at ${stamp}: ${reason}`)
    const updated = await board.patch(task.id, {
      state: 'failed',
      error: `rejected by operator: ${reason}`,
      notes,
    })
    await publishSnapshot().catch(() => {})
    return { id: updated.id, state: updated.state }
  }

  /** `task_control` actions the panel may run over HTTP. */
  const PANEL_ACTIONS: ReadonlySet<string> = new Set(['resume', 'block', 'suspend', 'retry', 'cancel', 'cancel_tree'])

  /**
   * Run one `task_control` action from the router panel. The request has no
   * calling agent, so `resume` delivers through the row's dispatcher, the last
   * caller, or the 作战室 anchor, in that order (the boot-resume path uses the anchor too).
   */
  const controlFromPanel = async (
    taskId: string,
    action: string,
    value: string | undefined,
    extra: { readonly prerequisite?: string; readonly waitFor?: readonly string[] } = {},
  ): Promise<{ id: string; state: TaskState; text: string }> => {
    if (!PANEL_ACTIONS.has(action)) {
      throw new BridgeError(400, 'bad-request', `action must be one of ${[...PANEL_ACTIONS].join(', ')}`)
    }
    const task = board.get(taskId)
    if (task === undefined) throw new BridgeError(404, 'not-found', `unknown task "${taskId}"`)
    if (task.state === 'running' || task.state === 'dispatched') {
      if (action === 'resume') throw new BridgeError(409, 'conflict', `${task.id} is still in flight ("${task.state}")`)
    }
    if (action === 'suspend') {
      const out = await suspendTask({
        taskId: task.id,
        reason: value ?? '',
        ...extra.prerequisite === undefined ? {} : { prerequisite: extra.prerequisite },
        ...extra.waitFor === undefined ? {} : { waitFor: extra.waitFor },
      }).catch((error: unknown) => { throw new BridgeError(409, 'conflict', error instanceof Error ? error.message : String(error)) })
      return { id: out.task.id, state: out.task.state, text: out.text }
    }
    let agent: LiveAgent | undefined
    if (action === 'retry') {
      agent = liveAgent(task.dispatchFrom) ?? lastCaller ?? await ensureAnchor().catch(() => undefined)
    }
    if (action === 'resume') {
      agent = liveAgent(task.dispatchFrom) ?? lastCaller ?? await ensureAnchor().catch(() => undefined)
      if (agent === undefined) {
        throw new BridgeError(503, 'unavailable', `no live agent can deliver the resume of ${task.id} (dispatcher ${task.dispatchFrom ?? '-'} is gone and no 作战室 anchor is available)`)
      }
    }
    const out = await taskControl(
      { task_id: task.id, action, ...value === undefined ? {} : { value }, by: 'human' },
      { ...agent === undefined ? {} : { agent }, signal: AbortSignal.timeout(60_000) },
    )
    const after = board.get(task.id)!
    return { id: after.id, state: after.state, text: out.text }
  }

  /** Flip one partition's operator switch and persist it on the board. */
  const setPartitionState = async (name: string, enabled: boolean): Promise<{ id: string; enabled: boolean }> => {
    const partition = partitions.find(entry => entry.name === name)
    if (partition === undefined) {
      throw new BridgeError(
        404,
        'not-found',
        `unknown partition "${name}"; configured: ${partitions.map(entry => entry.name).join(', ')}`,
      )
    }
    await board.patchPartition(name, { disabled: !enabled })
    // Re-enabling is also the moment to drain whatever queued up meanwhile.
    if (enabled) await pump(name, undefined)
    await publishSnapshot().catch(() => {})
    return { id: name, enabled }
  }

  /**
   * Presence (never a value) of the configured credential references.
   *
   * `ctx.credentials.describe(ref)` answers "is something stored for this
   * reference, where from, and is it writable" without returning the value,
   * which is exactly the badge the panel draws next to a key it does not own.
   */
  const credentialStatus = async (): Promise<readonly UiCredentialView[]> => {
    const service = ctx.get('credentials') as CredentialsServiceLike | undefined
    const refs = config.credentialRefs ?? DEFAULT_CREDENTIAL_REFS
    const views: UiCredentialView[] = []
    for (const entry of refs) {
      const label = entry.label === undefined ? {} : { label: entry.label }
      if (service === undefined || typeof service.describe !== 'function') {
        views.push({ ref: entry.ref, ...label, configured: false, source: 'unknown' })
        continue
      }
      try {
        const info = await service.describe(entry.ref)
        views.push({
          ref: entry.ref,
          ...label,
          configured: info?.configured === true,
          source: credentialSourceOf(info?.source),
          ...info?.writable === undefined ? {} : { writable: info.writable === true },
        })
      } catch (error) {
        // A provider that cannot answer is not the same as a missing key, so the
        // row says `unknown` instead of claiming the key is absent.
        views.push({ ref: entry.ref, ...label, configured: false, source: 'unknown' })
        ctx.logger.warn(`host-router: could not describe credential ${entry.ref}: ${String(error)}`)
      }
    }
    return views
  }

  /** Shared tool-result body for `route_task`. */
  const routeResult = (task: RouterTask, note: string): Record<string, string> => ({
    task: task.id,
    partition: task.partition,
    state: task.state,
    worker: task.worker ?? '-',
    session: task.sessionId ?? '-',
    text: [
      `${task.id} -> partition "${task.partition}" (${task.reason}: ${task.because.join('; ')})`,
      `level ${task.level}; state ${task.state}; worker ${task.worker ?? '-'}; session ${task.sessionId ?? '-'}`,
      task.error === undefined ? '' : `error: ${task.error}`,
      note,
    ].filter(line => line !== '').join('\n'),
  })

  // --- Level 1: publish ------------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'route_task',
    description: 'Publish one task to a file partition. The partition is resolved from an explicit name, '
      + 'from the files the task touches, or from the request text, and the call returns immediately. '
      + 'A continuable worker session is started in that partition; when the partition has a manager, '
      + 'the manager decomposes the task into workers instead. The worker\'s report arrives later as a '
      + 'message, and task_progress shows what each worker is doing meanwhile.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'The complete instruction. A worker has none of this conversation, so state the goal, '
            + 'the constraints, and what evidence of completion would look like.',
        },
        partition: {
          type: 'string',
          description: 'Explicit partition name. Omit to let the router decide from files or text.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute file paths the task touches; all must belong to one partition.',
        },
        subject: { type: 'string', description: 'Short title for the board.' },
        priority: { type: 'integer', description: 'Higher runs first; ties run oldest first. Default 0.' },
        parent_task: {
          type: 'string',
          description: 'Task id this one belongs under. A partition manager must pass its own task id here.',
        },
        verify: {
          type: 'array',
          items: { type: 'string' },
          description: 'Acceptance commands overriding the partition default. Empty means unverified.',
        },
        tier: {
          type: 'string',
          enum: ['easy', 'medium', 'hard'],
          description: 'Difficulty tier, which picks the worker model. Omit to let the router classify '
            + '(a `[tier:hard]` marker in text works too).',
        },
        depends_on: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids (returned by earlier route_task calls) that must finish before this task '
            + 'starts. The task is published now and waits in the queue; the router starts it automatically '
            + 'when they are done.',
        },
        stage: {
          type: 'integer',
          minimum: 0,
          description: 'Phase number among tasks with the same parent_task: a task starts only after every '
            + 'sibling with a lower stage has finished. E.g. stage 1 for tasks 1-3 and stage 2 for tasks 4-6.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'partition', 'state', 'worker', 'session', 'text'],
        properties: {
          task: { type: 'string' },
          partition: { type: 'string' },
          state: { type: 'string' },
          worker: { type: 'string' },
          session: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as RouteArgs
      if (exec.agent !== undefined) lastCaller = exec.agent
      if (typeof args.text !== 'string' || args.text.trim() === '') {
        throw new Error('route_task requires non-empty text')
      }
      // The dispatcher's own context, not the worker's: a child starts empty, so
      // the only session this call can bloat is the one making the decision.
      const refused = exec.agent === undefined
        ? undefined
        : await attachRefusal(exec.agent.session.id, 'This session')
      if (refused !== undefined) {
        throw new Error(`${refused} Finish the work yourself instead of delegating it.`)
      }
      const badOrder = dependencyError(args.depends_on, board.list())
      if (badOrder !== undefined) throw new Error(badOrder)
      if (args.stage !== undefined && (!Number.isInteger(args.stage) || args.stage < 0)) {
        throw new Error('stage must be a non-negative integer')
      }
      const decision = await route(args)
      if (!isEnabled(decision.partition.name)) {
        throw new Error(`partition "${decision.partition.name}" is disabled; enable it from the router panel first`)
      }
      // A manager always passes parent_task; that is the signal that this call is
      // level 2 and must start a worker rather than another manager.
      const fromManager = args.parent_task !== undefined
      const level = decision.partition.managerEnabled && !fromManager ? 'manager' : 'worker'
      // A 快任务 runs on the fast model unless the caller named a tier.
      const tier = decision.partition.quick === true && !isTier(args.tier)
        ? { tier: 'easy' as const, source: 'explicit' as const, reason: '快任务：用快模型' }
        : await decideTier(args)
      const task = await enqueue(args, decision, level, exec.agent, tier)
      await pump(decision.partition.name, exec.agent)
      const after = board.get(task.id) ?? task
      const gate = after.state === 'queued' ? orderGate(after) : READY
      return routeResult(after, gate.kind === 'wait'
        ? `Waiting for ${gate.on.join(', ')} to finish; it starts automatically then. Keep publishing the other pieces now.`
        : after.state === 'queued'
          ? 'Queued: a worker limit is reached or no live parent agent was found. It starts when a slot frees (task_board re-drives it).'
          : after.state === 'blocked'
            ? `Blocked: ${after.resumeNote ?? 'a prerequisite cannot finish'}`
            : 'Dispatched. Its report will arrive as a message; task_progress shows worker detail.')
    },
  }))

  // --- Read-only surfaces ----------------------------------------------------

  ctx.effect(() => ctx.tools.register({
    name: 'partition_list',
    description: 'List the configured file partitions with their roots, membership globs, worker '
      + 'capacity, current load, manager flag, and acceptance commands. Read this before publishing '
      + 'when the target partition is not obvious.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const lines = partitions.map((partition) => {
        const load = runningCount(partition.name)
        const queued = board.inPartition(partition.name).filter(task => task.state === 'queued').length
        const verify = autoVerify && (partition.verify?.length ?? 0) > 0
          ? `verify: ${partition.verify!.join(' | ')}`
          : 'verify: none (a normal worker end is recorded as `done`)'
        return [
          `- ${partition.name}: ${partition.dir}${isEnabled(partition.name) ? '' : '  [DISABLED]'}`,
          `  include: ${(partition.include ?? ['**']).join(', ')}`
            + (partition.exclude === undefined ? '' : `; exclude: ${partition.exclude.join(', ')}`),
          `  workers: ${String(load)}/${partition.slots === 0 ? 'unlimited' : String(partition.slots)} live, ${String(queued)} queued; `
            + `manager: ${partition.managerEnabled ? 'yes' : 'no'}`
            + (partition.preset === undefined ? '' : `; preset: ${partition.preset}`),
          `  ${verify}`,
          `  network: ${partition.network ?? 'undeclared (workers are not told)'}`
            + (partition.git?.branch === undefined ? '' : `; git branch: ${partition.git.branch}`),
        ].join('\n')
      })
      return { text: lines.join('\n') }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'task_board',
    description: 'Read the durable routing board: one line per task with its partition, routing level, '
      + 'state, and age; with a task id, the full record plus its child tasks. `reported` means a worker '
      + 'claimed success and acceptance has not confirmed it; `verified` means acceptance passed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'Read one task in full.' },
        partition: { type: 'string', description: 'Only tasks of this partition.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw) {
      const args = raw as { task_id?: string; partition?: string }
      if (args.partition !== undefined) {
        if (!partitions.some(entry => entry.name === args.partition)) {
          throw new Error(`unknown partition "${args.partition}"`)
        }
        // A human looking at the board is the most reliable moment to notice work
        // left queued by a restart, so reading also re-drives the queue.
        await pump(args.partition, undefined)
      }
      if (args.task_id !== undefined) {
        const task = board.get(args.task_id)
        if (task === undefined) throw new Error(`unknown task "${args.task_id}"`)
        const children = board.childrenOf(task.id)
        return {
          text: [
            JSON.stringify(task, undefined, 2),
            children.length === 0 ? '(no child tasks)' : `children:\n${summarize(children)}`,
          ].join('\n'),
        }
      }
      const tasks = args.partition === undefined ? board.list() : board.inPartition(args.partition)
      return { text: summarize(tasks, args.partition === undefined ? {} : { partition: args.partition }) }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'task_progress',
    description: 'Read the whole routing snapshot in one call: every task with its partition, state, '
      + 'coarse progress, and its worker session id plus that worker\'s own todo list (done/total). '
      + 'This is the same document the UI reads, so use it to answer "how is each task going".',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        partition: { type: 'string', description: 'Only this partition.' },
        task_id: { type: 'string', description: 'Only this task.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw) {
      const args = raw as { partition?: string; task_id?: string }
      const snapshot = await publishSnapshot()
      const tasks = args.partition === undefined
        ? snapshot.tasks
        : snapshot.tasks.filter(task => task.partition === args.partition)
      const scoped = args.task_id === undefined ? tasks : tasks.filter(task => task.id === args.task_id)
      if (args.task_id !== undefined && scoped.length === 0) {
        throw new Error(`unknown task "${args.task_id}"`)
      }
      const lines = scoped.map((task: TaskView) => {
        const bar = `${String(Math.round(task.progress * 100))}%`
        const todos = task.todos.total === 0
          ? 'no todo list'
          : `${task.todos.ratio} todos${task.todos.current === undefined ? '' : `, now: ${task.todos.current}`}`
        return `${mark(task.state)} ${task.id} ${task.partition}/${task.level} ${bar} ${todos}`
          + ` | session ${task.sessionId ?? '-'} | ${task.subject}`
          + (task.error === undefined ? '' : `\n    error: ${task.error}`)
      })
      return {
        text: [
          `${String(scoped.length)} task(s), generated ${snapshot.generatedAt}`,
          JSON.stringify(snapshot.counts),
          ...lines,
        ].join('\n'),
      }
    },
  }))

  // --- Control ---------------------------------------------------------------

  /** Every row below one task, at any depth. */
  const descendantsOf = (taskId: string): RouterTask[] => {
    const out: RouterTask[] = []
    const seen = new Set<string>([taskId])
    const walk = (id: string): void => {
      for (const child of board.childrenOf(id)) {
        if (seen.has(child.id)) continue
        seen.add(child.id)
        out.push(child)
        walk(child.id)
      }
    }
    walk(taskId)
    return out
  }

  /**
   * Stop one row: interrupt its worker's turn, drop the activation, mark it
   * cancelled. A human stop also tells the manager above it.
   * @returns the session that was interrupted, if any.
   */
  const stopRow = async (task: RouterTask, reason: string | undefined, byHuman: boolean): Promise<string | undefined> => {
    const activation = inFlight.get(task.id)
    const sessionId = activation?.childId ?? task.sessionId
    const live = activation !== undefined || task.state === 'running' || task.state === 'dispatched' || task.state === 'interrupted'
    if (sessionId !== undefined && live) {
      try { cancelWorker(ctx.get('subagents')!, sessionId) } catch (error) {
        ctx.logger.warn(`host-router: stopping ${task.id}: interrupt ${sessionId} failed: ${String(error)}`)
      }
    }
    if (activation !== undefined) await activation.dispose().catch(() => {})
    inFlight.delete(task.id)
    const note = byHuman ? `人工停止${reason === undefined || reason.trim() === '' ? '' : `: ${reason.trim()}`}` : reason
    await board.patch(task.id, {
      state: 'cancelled',
      ...note === undefined || note === '' ? {} : { error: `cancelled: ${note}` },
    })
    if (byHuman) await tellManager(task, reason)
    return live ? sessionId : undefined
  }

  /**
   * Tell the manager that owns a row, when that manager is still working, that a
   * human stopped the row, so it neither waits for it nor dispatches it again.
   */
  const tellManager = async (task: RouterTask, reason: string | undefined, notice?: string): Promise<void> => {
    const parent = task.parentId === undefined ? undefined : board.get(task.parentId)
    if (parent === undefined || parent.level !== 'manager' || parent.sessionId === undefined) return
    if (parent.state !== 'running' && parent.state !== 'dispatched') return
    const sender = liveAgent(parent.dispatchFrom) ?? await ensureAnchor().catch(() => undefined)
    if (sender === undefined) return
    const text = notice ?? [
      `【系统通知】用户手动停止了你的子任务 ${task.id}「${task.subject}」${reason === undefined || reason.trim() === '' ? '' : `，原因：${reason.trim()}`}。`,
      '不要重新派发它，也不要再等它。其余子任务照常进行；汇总时说明这一项已被人工停止。',
    ].join('\n')
    try {
      await continueWorker(ctx.get('subagents')!, sender, parent.sessionId, text, AbortSignal.timeout(30_000))
    } catch (error) {
      ctx.logger.warn(`host-router: could not tell manager ${parent.id} about ${task.id}: ${String(error)}`)
    }
  }

  /**
   * One `task_control` action. Shared by the tool and by `POST /api/router/control`,
   * so a panel click changes the row exactly as the tool would.
   */
  const taskControl = async (
    args: { task_id: string; action: string; value?: string; by?: 'human' },
    exec: ToolRunContext,
  ): Promise<{ text: string }> => {
      if (exec.agent !== undefined) lastCaller = exec.agent
      const task = board.get(args.task_id)
      if (task === undefined) throw new Error(`unknown task "${args.task_id}"`)
      const partition = partitionOf(task)

      switch (args.action) {
        case 'cancel': {
          if (SETTLED.has(task.state)) return { text: `${task.id} already ended ("${task.state}")` }
          const sessionId = await stopRow(task, args.value, args.by === 'human')
          // Rows waiting on it can no longer start: park them for a human now.
          await afterChange().catch(() => {})
          await publishSnapshot().catch(() => {})
          return {
            text: `${task.id} cancelled (${sessionId === undefined ? 'no live worker' : `interrupted ${sessionId}`})`,
          }
        }
        case 'cancel_tree': {
          // The whole request under this row: the row itself, then every open
          // descendant. The parent goes first so a manager cannot react to its
          // children stopping by dispatching them again.
          const family = [task, ...descendantsOf(task.id)].filter(row => !SETTLED.has(row.state))
          if (family.length === 0) return { text: `${task.id} and its tasks already ended` }
          const stopped: string[] = []
          for (const row of family) {
            const current = board.get(row.id)
            if (current === undefined || SETTLED.has(current.state)) continue
            await stopRow(current, args.by === 'human' ? `人工停止整个需求${args.value === undefined || args.value.trim() === '' ? '' : `: ${args.value.trim()}`}` : args.value ?? 'stopped with the whole request', false)
            stopped.push(current.id)
          }
          // A human stopping a subtree inside a larger request: the manager above
          // it still runs and has to know.
          if (args.by === 'human') await tellManager(task, args.value)
          await afterChange().catch(() => {})
          await publishSnapshot().catch(() => {})
          return { text: `stopped ${String(stopped.length)} task(s): ${stopped.join(', ')}` }
        }
        case 'priority': {
          const value = Number(args.value)
          if (!Number.isInteger(value)) throw new Error('priority requires an integer value')
          const updated = await board.patch(task.id, { priority: value })
          await pump(partition.name, exec.agent ?? lastCaller)
          return { text: `${updated.id} priority -> ${String(value)}` }
        }
        case 'retry': {
          // The work moved to another row (改派): running this one again would do it twice.
          if (task.reassignedTo !== undefined) throw new Error(`${task.id} was reassigned to ${task.reassignedTo}; retry that row instead`)
          if (task.state === 'running' || task.state === 'dispatched') {
            throw new Error(`${task.id} is still in flight; cancel it first`)
          }
          const parent = exec.agent ?? liveAgent(task.dispatchFrom) ?? lastCaller
          if (parent === undefined) throw new Error('retry needs a live agent to own the new worker')
          await board.patch(task.id, { state: 'queued' })
          await pump(partition.name, parent)
          const after = board.get(task.id)!
          // A retried prerequisite un-parks the rows that were waiting on it.
          await afterChange().catch(() => {})
          await publishSnapshot().catch(() => {})
          return { text: `${after.id} state ${after.state}; worker ${after.worker ?? '-'}` }
        }
        case 'resume': {
          if (task.reassignedTo !== undefined) throw new Error(`${task.id} was reassigned to ${task.reassignedTo}; resume that row instead`)
          if (task.state === 'running' || task.state === 'dispatched') {
            throw new Error(`${task.id} is still in flight`)
          }
          // Suspended, or parked because a prerequisite failed: a human says go on
          // without waiting any longer.
          if (task.state === 'suspended' || (task.state === 'blocked' && task.blockedFrom !== undefined && (task.waitingOn?.length ?? 0) > 0)) {
            const fromQueue = task.state === 'blocked' && task.blockedFrom === 'queued'
            if (fromQueue || (task.state === 'suspended' && task.sessionId === undefined)) {
              await board.patch(task.id, { state: 'queued', waitingOn: [], ignoreOrder: true })
              await pump(partition.name, exec.agent ?? lastCaller)
              await publishSnapshot().catch(() => {})
              const after = board.get(task.id)!
              notice(`任务 ${task.id}（${task.subject}）按你的决定不再等前置，现在 ${after.state === 'queued' ? '排队' : '开始执行'}。`, after)
              return { text: `${after.id} state ${after.state} (order skipped by request)` }
            }
            try {
              const line = await wakeRow(task, args.value)
              notice(`挂起的任务 ${task.id}（${task.subject}）已手动继续。`, task)
              await publishSnapshot().catch(() => {})
              return { text: line }
            } catch (error) {
              throw new Error(`could not continue ${task.id} in its session: ${String(error)}; use retry for a fresh worker`)
            }
          }
          const sender = exec.agent ?? liveAgent(task.dispatchFrom) ?? lastCaller
          if (sender === undefined) throw new Error('resume needs a live agent to own the delivery')
          let line: string
          try {
            const text = task.state === 'blocked'
              ? [
                  '【系统通知】你的任务曾被挂起等待人工决策，现已恢复。你的会话历史和 todo 列表都还在。',
                  `挂起原因：${task.resumeNote ?? '(无)'}`,
                  ...args.value === undefined ? [] : [`人工决定：${args.value}`],
                  '请从中断的那一步继续，已经完成的步骤不要重做。',
                ].join('\n')
              : RESUME_TEXT
            line = await resumeRow({ ...task, resumes: 0 }, sender, text)
          } catch (error) {
            // The original session cannot take the message (gone, or not in this
            // tree): say so on the row instead of leaving it parked and silent.
            const reason = `resume failed, original session ${task.sessionId ?? '-'} unavailable: ${String(error)}; use retry for a fresh worker`
            await board.patch(task.id, { state: 'failed', error: reason })
            await publishSnapshot().catch(() => {})
            return { text: `${task.id} -> failed (${reason})` }
          }
          await publishSnapshot().catch(() => {})
          return { text: line }
        }
        case 'verify': {
          const commands = task.verify ?? partition.verify ?? []
          const verdict = await runVerify(commands, partition.dir, verifyTimeout)
          const updated = await board.patch(task.id, {
            state: verdict.ok ? 'verified' : 'failed',
            verify: commands,
            verifyOutput: tail(verdict.output),
            ...verdict.ok ? {} : { error: `acceptance failed: ${verdict.failed ?? 'unknown command'}` },
          })
          await publishSnapshot().catch(() => {})
          return { text: `${updated.id} -> ${updated.state}\n${tail(verdict.output)}` }
        }
        case 'block': {
          const wasInFlight = task.state === 'running' || task.state === 'dispatched'
          // Persist `blocked` first: the interrupted turn then settles into
          // `finish`, which leaves a row that is no longer running/dispatched alone.
          const updated = await board.patch(task.id, {
            state: 'blocked',
            resumeNote: args.value ?? '(no note)',
            // A human block is not a dependency block: nothing unparks it but a human.
            waitingOn: [],
          })
          // A blocked row holds no slot (`holdsSlot`), so its worker must really
          // stop; the session and its log stay, and `resume` continues it there.
          const sessionId = inFlight.get(task.id)?.childId ?? task.sessionId
          if (wasInFlight && sessionId !== undefined) {
            try {
              cancelWorker(ctx.get('subagents')!, sessionId)
            } catch (error) {
              ctx.logger.warn(`host-router: blocking ${task.id}: interrupt ${sessionId} failed: ${String(error)}`)
            }
          }
          await publishSnapshot().catch(() => {})
          if (wasInFlight) await pump(partition.name, exec.agent ?? lastCaller).catch(() => {})
          return {
            text: `${updated.id} blocked: ${updated.resumeNote ?? ''}`
              + (wasInFlight && sessionId !== undefined ? ` (worker ${sessionId} interrupted; session kept for resume)` : ''),
          }
        }
        case 'suspend': {
          const out = await suspendTask({ taskId: task.id, reason: args.value ?? '', ...exec.agent === undefined ? {} : { caller: exec.agent } })
          return { text: out.text }
        }
        case 'note': {
          if (args.value === undefined) throw new Error('note requires a value')
          const updated = await board.note(task.id, args.value)
          return { text: `${updated.id} has ${String(updated.notes?.length ?? 0)} note(s)` }
        }
        default:
          throw new Error(`unknown action "${args.action}"`)
      }
  }

  /** Partition a tool call is about: explicit, else the calling manager's own partition. */
  const partitionForCall = (explicit: string | undefined, exec: ToolRunContext): Partition => {
    if (explicit !== undefined && explicit.trim() !== '') {
      const found = partitions.find(entry => entry.name === explicit.trim())
      if (found === undefined) throw new Error(`unknown partition "${explicit}"; partition_list shows the names`)
      return found
    }
    const callerSession = exec.agent?.session.id
    const own = callerSession === undefined
      ? undefined
      : board.list().find(task => task.level === 'manager' && task.sessionId === callerSession)
    if (own !== undefined) return partitionOf(own)
    if (partitions.length === 1) return partitions[0]!
    throw new Error('pass partition: this call does not come from a partition manager')
  }

  /** Task id of the calling manager, when the caller is one. */
  const managerTaskOf = (exec: ToolRunContext): string | undefined => {
    const callerSession = exec.agent?.session.id
    if (callerSession === undefined) return undefined
    return board.list().find(task => task.level === 'manager' && task.sessionId === callerSession)?.id
  }

  const textOutput = {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string' } },
    },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: (value as { text: string }).text }],
  }

  ctx.effect(() => ctx.tools.register({
    name: 'session_list',
    description: 'List the worker sessions of one partition, newest first: open ones (running, queued, '
      + 'suspended, blocked) always, then recent finished ones. Each line has the task id, the session id, the '
      + 'state, the subject, and what the worker said it did. A manager omits `partition` to get its own.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        partition: { type: 'string', description: 'Partition name; a manager may omit it.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many sessions (default 30).' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { partition?: string; limit?: number }
      const partition = partitionForCall(args.partition, exec)
      const lines = sessionRoster(board.inPartition(partition.name), Math.min(100, Math.max(1, args.limit ?? 30)))
      return {
        text: lines.length === 0
          ? `${partition.name}: no worker sessions yet`
          : [`${partition.name}: ${String(lines.length)} session(s)`, ...lines].join('\n'),
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'session_read',
    description: 'Read what one worker session actually did: the end of its transcript (messages, tool calls '
      + 'and results, turn ends), plus the task record. Use it before continuing or redoing earlier work, or to '
      + 'answer "what happened in that session". Read-only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'Task whose session to read.' },
        session_id: { type: 'string', description: 'Or the session id directly (from session_list).' },
        last: { type: 'integer', minimum: 1, maximum: 80, description: 'Transcript entries from the end (default 20).' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw) {
      const args = raw as { task_id?: string; session_id?: string; last?: number }
      const task = args.task_id !== undefined
        ? board.get(args.task_id)
        : args.session_id === undefined ? undefined : board.list().find(row => row.sessionId === args.session_id)
      if (args.task_id !== undefined && task === undefined) throw new Error(`unknown task "${args.task_id}"`)
      const sessionId = task?.sessionId ?? args.session_id
      if (sessionId === undefined) {
        throw new Error(args.task_id === undefined ? 'pass task_id or session_id' : `${args.task_id} has no session yet`)
      }
      // Only sessions the router started: this tool is a window on partitions, not on every chat.
      if (task === undefined) throw new Error(`session ${sessionId} does not belong to any routed task`)
      const events = await readLog(sessionId)
      const transcript = renderTranscript(events, Math.min(80, Math.max(1, args.last ?? 20)))
      const head = [
        `${task.id} ${task.partition}/${task.level} [${task.state}] session ${sessionId}`,
        `subject: ${task.subject}`,
        ...task.summary === undefined ? [] : [`did: ${task.summary}`],
        ...task.touched === undefined || task.touched.length === 0 ? [] : [`touched: ${task.touched.join(', ')}`],
        ...task.left === undefined ? [] : [`left: ${task.left}`],
        ...task.error === undefined ? [] : [`error: ${task.error}`],
      ]
      return {
        text: [
          ...head,
          '',
          events.length === 0
            ? '(the session log is empty or could not be read)'
            : `--- last ${String(transcript.length)} transcript entries ---`,
          ...transcript,
        ].join('\n'),
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'partition_memory',
    description: 'A partition\'s durable memory, kept across requests. `read` returns its notes and recent '
      + 'work log (optionally filtered by `query`); `note` adds one lasting fact (a convention, a decision, a '
      + 'pitfall, where something lives); `forget` removes a note by id. Finished tasks are logged '
      + 'automatically, so do not note them. A manager omits `partition` to use its own.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['read', 'note', 'forget'] },
        partition: { type: 'string', description: 'Partition name; a manager may omit it.' },
        text: { type: 'string', description: 'For `note`: one short fact.' },
        id: { type: 'string', description: 'For `forget`: the note id (n-xxxxxxxx).' },
        query: { type: 'string', description: 'For `read`: keep notes and log lines containing this text.' },
        limit: { type: 'integer', minimum: 1, maximum: 300, description: 'For `read`: log entries (default 40).' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { action?: string; partition?: string; text?: string; id?: string; query?: string; limit?: number }
      const partition = partitionForCall(args.partition, exec)
      if (args.action === 'note') {
        if (typeof args.text !== 'string') throw new Error('note needs text')
        const managerTask = managerTaskOf(exec)
        const note = await memory.addNote(partition.name, args.text, managerTask === undefined ? 'router' : 'manager', managerTask)
        await publishSnapshot().catch(() => {})
        return { text: `noted in ${partition.name}: [${note.id}] ${note.text}` }
      }
      if (args.action === 'forget') {
        if (typeof args.id !== 'string' || args.id === '') throw new Error('forget needs the note id')
        const removed = await memory.removeNote(partition.name, args.id)
        if (!removed) throw new Error(`no note ${args.id} in ${partition.name}`)
        await publishSnapshot().catch(() => {})
        return { text: `forgot ${args.id} in ${partition.name}` }
      }
      if (args.action !== 'read') throw new Error('action must be read, note, or forget')
      const doc = await memory.read(partition.name)
      const query = args.query?.trim().toLowerCase()
      const keep = (text: string): boolean => query === undefined || query === '' || text.toLowerCase().includes(query)
      const notes = doc.notes.filter(note => keep(note.text))
      const log = doc.log.filter(entry => keep(workLine(entry))).slice(-Math.min(300, Math.max(1, args.limit ?? 40))).reverse()
      return {
        text: [
          `${partition.name} memory: ${String(doc.notes.length)} note(s), ${String(doc.log.length)} logged task(s)`,
          '',
          'notes:',
          ...notes.length === 0 ? ['(none)'] : notes.map(note => `- [${note.id}] (${note.by}) ${note.text}`),
          '',
          'work log (newest first):',
          ...log.length === 0 ? ['(none)'] : log.map(entry => workLine(entry)),
        ].join('\n'),
      }
    },
  }))

  // --- Outlets: code host, server commands, headless browser ---------------------
  //
  // Each outlet call is checked against the partition's policy (outlets.ts). A call
  // a human must see becomes an approval; the human's 同意 in the panel runs it once
  // and the outcome goes back to the session that asked.

  const policyOf = (partition: Partition, kind: OutletKind): OutletMode => {
    if (kind === 'merge') return 'confirm'
    return partition.outlets?.[kind] ?? DEFAULT_POLICY[kind]
  }

  /** The routed row whose session made this call, if any. */
  const callerTask = (exec: ToolRunContext): RouterTask | undefined => {
    const id = exec.agent?.session.id
    return id === undefined ? undefined : board.list().find(task => task.sessionId === id)
  }

  /** Partition of an outlet call: the caller's row, else the explicit name. */
  const outletPartition = (explicit: string | undefined, exec: ToolRunContext): Partition => {
    const mine = callerTask(exec)
    if (mine !== undefined) return partitionOf(mine)
    return partitionForCall(explicit, exec)
  }

  const scmClients = new Map<string, ScmClient>()
  // Test seam: a fake fetch for the code host. Never set in production config.
  const scmFetch = (config as { scmFetch?: Parameters<typeof createScmClient>[2] }).scmFetch
  const scmOf = (partition: Partition): ScmClient => {
    const scm = partition.git?.scm
    if (scm === undefined) throw new Error(`partition "${partition.name}" has no code host configured (git.scm)`)
    let client = scmClients.get(partition.name)
    if (client === undefined) {
      client = createScmClient(scm, () => envToken(scm), ...scmFetch === undefined ? [] : [scmFetch])
      scmClients.set(partition.name, client)
    }
    return client
  }

  /**
   * Tell whoever is still working on a row what became of its outlet call: the
   * worker itself while it runs, else its manager while that runs.
   */
  const notifyCaller = async (taskId: string | undefined, text: string): Promise<void> => {
    const task = taskId === undefined ? undefined : board.get(taskId)
    if (task === undefined) return
    const live = (row: RouterTask): boolean => row.sessionId !== undefined && (row.state === 'running' || row.state === 'dispatched')
    const target = live(task) ? task : task.parentId === undefined ? undefined : board.get(task.parentId)
    if (target === undefined || !live(target)) return
    const sender = liveAgent(target.dispatchFrom) ?? await ensureAnchor().catch(() => undefined)
    if (sender === undefined) return
    try {
      await continueWorker(ctx.get('subagents')!, sender, target.sessionId!, text, AbortSignal.timeout(30_000))
    } catch (error) {
      ctx.logger.warn(`host-router: could not tell ${target.id} about an outlet result: ${String(error)}`)
    }
  }

  /** Queue an approval and say so in the words the agent gets back. */
  const askHuman = async (input: Omit<Approval, 'id' | 'state' | 'createdAt'>): Promise<string> => {
    const approval = await outlets.request(input)
    await publishSnapshot().catch(() => {})
    return [
      `需要人工确认：已提交确认单 ${approval.id}（${approval.action}）。`,
      '用户在面板点「同意」后由路由执行一次，结果会发回你的会话（你已结束时发给你的 manager）。',
      '不要重复提交，也不要换别的方式绕过这一步。可以先继续做不依赖它的部分。',
    ].join('\n')
  }

  /** Commit the named paths (when asked), push the current branch, open or update its PR. */
  const publishBranch = async (
    partition: Partition,
    args: { readonly title?: string; readonly body?: string; readonly draft?: boolean; readonly paths?: readonly string[]; readonly commit_message?: string },
    taskId: string | undefined,
  ): Promise<string> => {
    const client = scmOf(partition)
    const cwd = partition.dir
    if (args.commit_message !== undefined && args.commit_message.trim() !== '') {
      const paths = args.paths ?? []
      if (paths.length === 0) throw new Error('commit_message needs the paths to commit (paths); the tree is shared, so nothing is added wholesale')
      for (const path of paths) {
        if (path.startsWith('-') || path.includes('..') || isAbsolute(path)) throw new Error(`path "${path}" must be relative to the partition and stay inside it`)
      }
      const added = await run('git', ['add', '--', ...paths], cwd)
      if (added.code !== 0) throw new Error(`git add failed: ${added.stderr.trim()}`)
      const committed = await run('git', ['commit', '-m', args.commit_message.trim()], cwd)
      if (committed.code !== 0 && !/nothing to commit/.test(committed.stdout + committed.stderr)) {
        throw new Error(`git commit failed: ${(committed.stderr || committed.stdout).trim()}`)
      }
    }
    const facts = await gitFacts(cwd)
    const base = await client.defaultBranch()
    const refused = pushableBranch(facts.branch, base)
    if (refused !== undefined) throw new Error(refused)
    const remote = partition.git?.scm?.remote ?? 'origin'
    const pushed = await run('git', ['push', '-u', remote, facts.branch], cwd, 180_000)
    if (pushed.code !== 0) throw new Error(`git push failed: ${pushed.stderr.trim() || pushed.stdout.trim()}`)
    let pr = await client.findOpen(facts.branch)
    let verb = 'updated'
    if (pr === undefined) {
      const title = args.title?.trim() || (taskId === undefined ? facts.branch : board.get(taskId)?.subject ?? facts.branch)
      pr = await client.open({ head: facts.branch, base, title, body: args.body ?? '', ...args.draft === true ? { draft: true } : {} })
      verb = 'opened'
    } else if ((args.title !== undefined && args.title.trim() !== '') || args.body !== undefined) {
      pr = await client.update(pr.number, {
        ...args.title !== undefined && args.title.trim() !== '' ? { title: args.title.trim() } : {},
        ...args.body === undefined ? {} : { body: args.body },
      })
    }
    if (taskId !== undefined && board.get(taskId) !== undefined) {
      await board.patch(taskId, { pr: { number: pr.number, url: pr.url, provider: client.provider } })
    }
    await outlets.audit({ kind: 'git', partition: partition.name, ...taskId === undefined ? {} : { taskId }, action: `push ${facts.branch}; ${verb} PR #${String(pr.number)}`, target: pr.url, outcome: 'ran', by: 'agent' })
    const dirty = facts.dirty.length === 0 ? '' : `\nnote: ${String(facts.dirty.length)} uncommitted path(s) stay local (not in the PR).`
    return `pushed ${facts.branch} to ${remote}; ${verb} PR #${String(pr.number)} -> ${pr.base}: ${pr.url}${dirty}`
  }

  /** Merge one PR, refusing when its head moved since the human approved. */
  const mergePull = async (partition: Partition, number: number, method: 'merge' | 'squash' | 'rebase', sha: string | undefined): Promise<string> => {
    const client = scmOf(partition)
    const pr = await client.get(number)
    if (pr.state !== 'open') throw new Error(`PR #${String(number)} is ${pr.state}`)
    if (sha !== undefined && pr.headSha !== sha) throw new Error(`PR #${String(number)} changed after it was approved (head ${pr.headSha.slice(0, 7)}, approved ${sha.slice(0, 7)}); ask again`)
    const out = await client.merge(number, method, pr.headSha)
    if (!out.merged) throw new Error(`not merged: ${out.message}`)
    return `merged PR #${String(number)} (${method}) into ${pr.base}: ${pr.url}`
  }

  const screenshotCommand = config.screenshotCommand ?? '/srv/workspace/bin/screenshot'

  /** Headless screenshot (or page text) of one URL, saved under the partition's artifacts. */
  const capturePage = async (partition: Partition, url: string, mode: 'screenshot' | 'text', full: boolean, taskId: string | undefined): Promise<string> => {
    let parsed: URL
    try { parsed = new URL(url) } catch { throw new Error(`"${url}" is not a URL`) }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('only http(s) pages can be opened')
    if (!hostAllowed(parsed.hostname, partition.outlets?.browserAllow)) {
      throw new Error(`${parsed.hostname} is not in this partition's browser allowlist (outlets.browserAllow)`)
    }
    if (mode === 'text') {
      const response = await fetch(parsed, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'dsh-router' } })
      const html = await response.text()
      const text = html
        .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
      return `HTTP ${String(response.status)} ${parsed.href}\n${text.slice(0, 6000)}${text.length > 6000 ? '…' : ''}`
    }
    const dir = join(partition.dir, '.dsh-artifacts', taskId ?? 'manual')
    await mkdir(dir, { recursive: true })
    const out = join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    const shot = await run(screenshotCommand, [parsed.href, out, ...full ? ['--full'] : []], partition.dir, 90_000)
    if (shot.code !== 0) throw new Error(`screenshot failed: ${(shot.stderr || shot.stdout).trim()}`)
    return out
  }

  /** Run one approved (or allowed) outlet action. */
  const executeOutlet = async (approval: Approval): Promise<string> => {
    const partition = partitions.find(entry => entry.name === approval.partition)
    if (partition === undefined) throw new Error(`partition "${approval.partition}" is gone`)
    const params = approval.params as Record<string, unknown>
    switch (approval.kind) {
      case 'merge':
        return await mergePull(partition, Number(params['number']), (params['method'] as 'merge' | 'squash' | 'rebase' | undefined) ?? 'squash', params['sha'] as string | undefined)
      case 'ops': {
        const result = await runShell(String(params['command']), partition.dir, 300_000)
        const text = [`exit ${String(result.code)}`, result.stdout.trim(), result.stderr.trim()].filter(part => part !== '').join('\n')
        if (result.code !== 0) throw new Error(text)
        return text
      }
      case 'git':
        return await publishBranch(partition, params as Parameters<typeof publishBranch>[1], approval.taskId)
      case 'browser':
        return await capturePage(partition, String(params['url']), params['mode'] === 'text' ? 'text' : 'screenshot', params['full'] === true, approval.taskId)
    }
  }

  /** A human's decision on one approval: run it once, or refuse it. */
  const decideApproval = async (id: string, decision: 'approve' | 'reject', note: string | undefined): Promise<Approval> => {
    await outlets.expire()
    const approval = outlets.get(id)
    if (approval === undefined) throw new BridgeError(404, 'not-found', `unknown approval "${id}"`)
    if (approval.state !== 'pending') throw new Error(`${id} is already ${approval.state}`)
    const base = { kind: approval.kind, partition: approval.partition, ...approval.taskId === undefined ? {} : { taskId: approval.taskId }, action: approval.action, target: approval.target }
    const at = new Date().toISOString()
    if (decision === 'reject') {
      const rejected = await outlets.patch(id, { state: 'rejected', decidedAt: at, ...note === undefined ? {} : { note } })
      await outlets.audit({ ...base, outcome: 'rejected', by: 'human', ...note === undefined ? {} : { detail: note } })
      await notifyCaller(approval.taskId, `【系统通知】用户拒绝了确认单 ${id}（${approval.action}）${note === undefined ? '' : `，说明：${note}`}。不要再执行这一步，也不要换方式绕过；在汇报里说明。`)
      await publishSnapshot().catch(() => {})
      return rejected
    }
    await outlets.patch(id, { state: 'approved', decidedAt: at, ...note === undefined ? {} : { note } })
    await outlets.audit({ ...base, outcome: 'approved', by: 'human', ...note === undefined ? {} : { detail: note } })
    let settled: Approval
    try {
      const result = await executeOutlet(approval)
      settled = await outlets.patch(id, { state: 'done', result: result.slice(0, 4000) })
      await outlets.audit({ ...base, outcome: 'ran', by: 'router', detail: result })
      await notifyCaller(approval.taskId, `【系统通知】确认单 ${id} 已获用户同意并执行：${approval.action}\n结果：${result.slice(0, 1500)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      settled = await outlets.patch(id, { state: 'failed', result: message.slice(0, 4000) })
      await outlets.audit({ ...base, outcome: 'failed', by: 'router', detail: message })
      await notifyCaller(approval.taskId, `【系统通知】确认单 ${id} 已获同意，但执行失败：${message.slice(0, 1500)}`)
    }
    await publishSnapshot().catch(() => {})
    return settled
  }

  ctx.effect(() => ctx.tools.register({
    name: 'git_publish',
    description: 'Publish committed work: push the current branch of this partition\'s checkout and open its pull '
      + 'request (or update the open one). Optionally commit first: pass `commit_message` with the exact `paths` you '
      + 'changed (the checkout is shared, so nothing is added wholesale). Refuses the default branch. Needs `git.scm` '
      + 'on the partition. Returns the PR URL.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', description: 'PR title (default: the task subject).' },
        body: { type: 'string', description: 'PR description.' },
        draft: { type: 'boolean', description: 'Open as a draft (GitHub).' },
        commit_message: { type: 'string', description: 'Commit these paths first with this message.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Paths to commit, relative to the partition root.' },
        partition: { type: 'string', description: 'Partition, when the caller is not a routed task.' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { title?: string; body?: string; draft?: boolean; commit_message?: string; paths?: string[]; partition?: string }
      const partition = outletPartition(args.partition, exec)
      const task = callerTask(exec)
      const mode = policyOf(partition, 'git')
      if (mode === 'off') throw new Error(`git publishing is off for partition "${partition.name}"`)
      scmOf(partition)
      if (mode === 'confirm') {
        return { text: await askHuman({ kind: 'git', partition: partition.name, ...task === undefined ? {} : { taskId: task.id }, action: `推送分支并开/更新 PR：${args.title ?? task?.subject ?? ''}`.trim(), target: partition.git!.scm!.repo, reason: args.body?.slice(0, 300) ?? '', reversible: true, params: args }) }
      }
      return { text: await publishBranch(partition, args, task?.id) }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'pr_status',
    description: 'Read a pull request of this partition\'s repository: state, mergeability and CI checks (failing and '
      + 'pending check names). Without `number` it reads the PR of the current branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        number: { type: 'integer', minimum: 1, description: 'PR number.' },
        partition: { type: 'string', description: 'Partition, when the caller is not a routed task.' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { number?: number; partition?: string }
      const partition = outletPartition(args.partition, exec)
      const client = scmOf(partition)
      const pr = args.number !== undefined
        ? await client.get(args.number)
        : await client.findOpen((await gitFacts(partition.dir)).branch)
      if (pr === undefined) return { text: 'no open pull request for the current branch' }
      const checks = await client.checks(pr.headSha)
      return {
        text: [
          `PR #${String(pr.number)} ${pr.state}${pr.draft ? ' (draft)' : ''}: ${pr.title}`,
          `${pr.head} -> ${pr.base} @ ${pr.headSha.slice(0, 7)}; mergeable: ${pr.mergeable === undefined ? 'unknown' : String(pr.mergeable)}`,
          `checks: ${checks.state} (${String(checks.total)})`
            + (checks.failing.length > 0 ? `; failing: ${checks.failing.join(', ')}` : '')
            + (checks.pending.length > 0 ? `; pending: ${checks.pending.join(', ')}` : ''),
          pr.url,
        ].join('\n'),
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'pr_merge',
    description: 'Ask to merge a pull request. Never merges by itself: it files an approval the human sees in the panel; '
      + 'on 同意 the router merges exactly the head it was shown (a later push voids it) and tells you the result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['number', 'reason'],
      properties: {
        number: { type: 'integer', minimum: 1, description: 'PR number.' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Merge method (default squash).' },
        reason: { type: 'string', description: 'Why it is ready: checks, review, what it changes.' },
        partition: { type: 'string', description: 'Partition, when the caller is not a routed task.' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { number: number; method?: 'merge' | 'squash' | 'rebase'; reason: string; partition?: string }
      const partition = outletPartition(args.partition, exec)
      const task = callerTask(exec)
      const client = scmOf(partition)
      const pr = await client.get(args.number)
      if (pr.state !== 'open') throw new Error(`PR #${String(pr.number)} is ${pr.state}`)
      const checks = await client.checks(pr.headSha)
      return {
        text: await askHuman({
          kind: 'merge', partition: partition.name, ...task === undefined ? {} : { taskId: task.id },
          action: `合并 PR #${String(pr.number)}「${pr.title}」到 ${pr.base}（${args.method ?? 'squash'}）`,
          target: pr.url,
          reason: `${args.reason.trim()}\nCI：${checks.state}${checks.failing.length > 0 ? `，失败：${checks.failing.join('、')}` : ''}`,
          reversible: false,
          params: { number: pr.number, method: args.method ?? 'squash', sha: pr.headSha },
        }),
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'ops_run',
    description: 'Run one command on the server, in the partition root, with its risk checked first. Read-only looks '
      + '(logs, status, disk, nginx -t, curl -I) run at once; changes run and are logged; dangerous commands (restart '
      + 'or stop a service, delete files, firewall, users, reboot, force-push) are not run: they become an approval '
      + 'the human sees, and run once on 同意. Always give the reason.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'reason'],
      properties: {
        command: { type: 'string', description: 'Shell command line.' },
        reason: { type: 'string', description: 'Why, and what you expect it to do.' },
        partition: { type: 'string', description: 'Partition, when the caller is not a routed task.' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { command: string; reason: string; partition?: string }
      const partition = outletPartition(args.partition, exec)
      const task = callerTask(exec)
      const mode = policyOf(partition, 'ops')
      if (mode === 'off') throw new Error(`server commands are off for partition "${partition.name}"`)
      const level = classifyCommand(args.command, partition.outlets?.danger)
      const where = { partition: partition.name, ...task === undefined ? {} : { taskId: task.id } }
      if (level === 'danger' || (mode === 'confirm' && level !== 'read')) {
        return {
          text: `[${level}] ${await askHuman({ kind: 'ops', ...where, action: `${level === 'danger' ? '危险' : '变更'}命令`, target: args.command, reason: args.reason, reversible: level !== 'danger', params: { command: args.command } })}`,
        }
      }
      const result = await runShell(args.command, partition.dir, 300_000)
      await outlets.audit({ kind: 'ops', ...where, action: `${level} command`, target: args.command, outcome: result.code === 0 ? 'ran' : 'failed', by: 'agent', detail: `exit ${String(result.code)}; ${args.reason}` })
      return { text: [`[${level}] exit ${String(result.code)}`, result.stdout.trim(), result.stderr.trim()].filter(part => part !== '').join('\n') }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'browser_capture',
    description: 'Open a page in a headless browser on the server and save a screenshot under the partition\'s '
      + '`.dsh-artifacts/<task>/` (mode `screenshot`), or read the page as plain text (mode `text`). Use screenshots as '
      + 'evidence for UI and site checks and list their paths in your report. Hosts may be limited per partition.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'http(s) URL.' },
        mode: { type: 'string', enum: ['screenshot', 'text'], description: 'Default screenshot.' },
        full: { type: 'boolean', description: 'Whole page instead of the first screen.' },
        partition: { type: 'string', description: 'Partition, when the caller is not a routed task.' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { url: string; mode?: 'screenshot' | 'text'; full?: boolean; partition?: string }
      const partition = outletPartition(args.partition, exec)
      const task = callerTask(exec)
      const mode = policyOf(partition, 'browser')
      if (mode === 'off') throw new Error(`the browser is off for partition "${partition.name}"`)
      if (mode === 'confirm') {
        return { text: await askHuman({ kind: 'browser', partition: partition.name, ...task === undefined ? {} : { taskId: task.id }, action: `无头浏览器打开页面（${args.mode ?? 'screenshot'}）`, target: args.url, reason: '', reversible: true, params: args }) }
      }
      const out = await capturePage(partition, args.url, args.mode ?? 'screenshot', args.full === true, task?.id)
      await outlets.audit({ kind: 'browser', partition: partition.name, ...task === undefined ? {} : { taskId: task.id }, action: args.mode ?? 'screenshot', target: args.url, outcome: 'ran', by: 'agent' })
      return { text: out }
    },
  }))

  // --- 改派 / 换模型, live output, batch ------------------------------------------

  /**
   * Move a task's work to another partition and/or model. The old row stops (if
   * it still runs) and points at the new one; the new row keeps the parent, the
   * stage and the prerequisites, and every row that waited on the old one now
   * waits on the new one. With `keepProgress` the new worker's brief carries what
   * the old one did and its last output; without it, only the original request.
   */
  const reassignTask = async (input: {
    readonly taskId: string
    readonly partition?: string
    readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
    readonly keepProgress: boolean
    readonly note?: string
  }, caller?: LiveAgent): Promise<{ readonly from: string; readonly to: string; readonly partition: string; readonly text: string }> => {
    const task = board.get(input.taskId)
    if (task === undefined) throw new Error(`unknown task "${input.taskId}"`)
    if (task.reassignedTo !== undefined) throw new Error(`${task.id} was already reassigned to ${task.reassignedTo}`)
    const target = input.partition === undefined ? partitionOf(task) : partitions.find(entry => entry.name === input.partition)
    if (target === undefined) throw new Error(`unknown partition "${input.partition ?? ''}"`)
    if (input.model !== undefined) {
      const known = await cachedModelOptions().catch(() => [] as ModelOption[])
      if (known.length > 0 && !known.some(option => option.provider === input.model!.provider && option.model === input.model!.model)) {
        throw new Error(`model ${input.model.provider}/${input.model.model} is not offered by the runtime`)
      }
    }
    if (target.name === task.partition && input.model === undefined && !input.keepProgress) {
      // Same place, same model, from scratch: that is a retry, which keeps the row.
      throw new Error('nothing to change: pick another partition or model, or use retry')
    }
    const wasOpen = !SETTLED.has(task.state)
    let transcript: string[] = []
    if (input.keepProgress && task.sessionId !== undefined) {
      transcript = renderTranscript(await readLog(task.sessionId), 10, 500)
    }
    const why = input.note ?? task.error ?? (wasOpen ? '人工改派' : undefined)
    const lines = [
      task.body,
      '',
      `--- 改派说明（原任务 ${task.id}，${task.partition}${task.model === undefined ? '' : ` / ${task.model}`}）---`,
      ...why === undefined ? [] : [`原因：${why}`],
    ]
    if (input.keepProgress) {
      lines.push(
        ...task.summary === undefined ? [] : [`上一个 worker 已做：${task.summary}`],
        ...task.touched === undefined || task.touched.length === 0 ? [] : [`它改过的文件：${task.touched.join('、')}`],
        ...task.left === undefined ? [] : [`它留下没做的：${task.left}`],
        ...transcript.length === 0 ? [] : ['它最后的输出：', ...transcript],
        '接着它的进度继续：先检查上面这些文件的现状再动手，不要从头重做已经完成的部分。',
      )
    } else {
      lines.push('从头开始做，不要沿用上一个 worker 的改动结论（先看文件现状）。')
    }
    if (wasOpen) await stopRow(task, `改派${why === undefined ? '' : `：${why}`}`, false)
    const created = await enqueue(
      {
        text: lines.join('\n'),
        subject: task.subject,
        priority: task.priority,
        ...task.parentId === undefined ? {} : { parent_task: task.parentId },
        ...task.dependsOn === undefined ? {} : { depends_on: task.dependsOn },
        ...task.stage === undefined ? {} : { stage: task.stage },
      },
      { partition: target, reason: 'explicit', because: [`reassigned from ${task.id}`] },
      task.level === 'manager' && target.managerEnabled ? 'manager' : 'worker',
      caller ?? liveAgent(task.dispatchFrom) ?? lastCaller,
    )
    await board.patch(created.id, {
      reassignedFrom: task.id,
      ...input.model === undefined ? {} : { routeOverride: input.model, tierSource: 'explicit', tierReason: `换模型：${input.model.model}` },
    })
    await board.patch(task.id, { reassignedTo: created.id, ...wasOpen ? {} : {} })
    // Rows that waited on the old task now wait on the new one.
    for (const row of board.list()) {
      if (row.id === created.id || row.dependsOn === undefined || !row.dependsOn.includes(task.id)) continue
      await board.patch(row.id, { dependsOn: row.dependsOn.map(id => id === task.id ? created.id : id) })
    }
    const parentAgent = caller ?? liveAgent(task.dispatchFrom) ?? lastCaller ?? await ensureAnchor().catch(() => undefined)
    await pump(target.name, parentAgent)
    const moved = `${task.id} -> ${created.id}（${target.name}${input.model === undefined ? '' : ` / ${input.model.model}`}，${input.keepProgress ? '接着做' : '从头来'}）`
    await tellManager(task, undefined, `【系统通知】你的子任务 ${task.id}「${task.subject}」被改派为 ${created.id}（${target.name}${input.model === undefined ? '' : `，模型 ${input.model.model}`}）。不要再等 ${task.id}，改为等 ${created.id}；不要重复派发。`)
    await afterChange().catch(() => {})
    await publishSnapshot().catch(() => {})
    return { from: task.id, to: created.id, partition: target.name, text: `reassigned ${moved}` }
  }

  /** One action over many rows, each reported on its own. */
  const BATCH_ACTIONS: ReadonlySet<string> = new Set(['cancel', 'cancel_tree', 'retry', 'suspend', 'resume', 'reassign'])
  const batchControl = async (taskIds: readonly string[], action: string, value: string | undefined): Promise<{
    readonly ok: number
    readonly failed: number
    readonly results: readonly { readonly id: string; readonly ok: boolean; readonly state?: string; readonly error?: string }[]
  }> => {
    if (!BATCH_ACTIONS.has(action)) throw new BridgeError(400, 'bad-request', `action must be one of ${[...BATCH_ACTIONS].join(', ')}`)
    const results: { id: string; ok: boolean; state?: string; error?: string }[] = []
    for (const id of taskIds) {
      try {
        if (action === 'reassign') {
          const out = await reassignTask({ taskId: id, ...value === undefined || value === '' ? {} : { partition: value }, keepProgress: true })
          results.push({ id, ok: true, state: `→ ${out.to}` })
        } else if (action === 'suspend') {
          const out = await controlFromPanel(id, 'suspend', value ?? '批量挂起')
          results.push({ id, ok: true, state: out.state })
        } else {
          const out = await controlFromPanel(id, action, value)
          results.push({ id, ok: true, state: out.state })
        }
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { ok: results.filter(row => row.ok).length, failed: results.filter(row => !row.ok).length, results }
  }

  /** A worker's live output since segment `after`. */
  const liveOutput = async (taskId: string, after: number): Promise<unknown> => {
    const task = board.get(taskId)
    if (task === undefined) throw new BridgeError(404, 'not-found', `unknown task "${taskId}"`)
    const base = { taskId: task.id, state: task.state, at: Date.now() }
    if (task.sessionId === undefined) return { ...base, segments: [] }
    const events = await readLog(task.sessionId)
    return { ...base, sessionId: task.sessionId, segments: liveSegments(events, after, 80) }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'task_reassign',
    description: 'Move a task to another partition and/or model instead of retrying it blindly. The old row stops '
      + 'and points at the new one; the new row keeps the parent, stage and prerequisites. `keep_progress` (default '
      + 'true) hands the new worker what the old one did and its last output; false starts from the request alone.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        partition: { type: 'string', description: 'Target partition (default: the same).' },
        provider: { type: 'string', description: 'Model provider, with `model`.' },
        model: { type: 'string', description: 'Model id to run on.' },
        reasoning_effort: { type: 'string' },
        keep_progress: { type: 'boolean' },
        note: { type: 'string', description: 'Why it moves.' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { task_id: string; partition?: string; provider?: string; model?: string; reasoning_effort?: string; keep_progress?: boolean; note?: string }
      if ((args.provider === undefined) !== (args.model === undefined)) throw new Error('pass provider and model together')
      const out = await reassignTask({
        taskId: args.task_id,
        ...args.partition === undefined ? {} : { partition: args.partition },
        ...args.provider === undefined || args.model === undefined ? {} : { model: { provider: args.provider, model: args.model, ...args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort } } },
        keepProgress: args.keep_progress !== false,
        ...args.note === undefined ? {} : { note: args.note },
      }, exec.agent)
      return { text: out.text }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'task_control',
    description: 'Change one task: `cancel` interrupts its worker and marks it cancelled; `cancel_tree` '
      + 'stops the task and every open task under it (a whole request, or a manager and its workers); `priority` '
      + 'reorders the queue; `retry` re-dispatches a failed or reported task to a fresh worker; '
      + '`resume` continues an interrupted or failed row in its own session from its log; '
      + '`verify` runs the acceptance commands against the current tree; `block` parks it on a human '
      + 'decision; `suspend` parks it to be finished later (use task_suspend to also name a prerequisite); '
      + '`resume` also continues a suspended task now, or starts a task held by a failed prerequisite; '
      + '`note` records a remark verbatim.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'action'],
      properties: {
        task_id: { type: 'string', description: 'Task id.' },
        action: {
          type: 'string',
          enum: ['cancel', 'cancel_tree', 'priority', 'retry', 'resume', 'verify', 'block', 'suspend', 'note'],
          description: 'What to change.',
        },
        value: {
          type: 'string',
          description: 'Priority for `priority`, remark for `note`, decision needed for `block`, the decision for `resume` of a blocked row, reason for `cancel`.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      return await taskControl(raw as { task_id: string; action: string; value?: string }, exec)
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'task_resume',
    description: 'Continue an existing worker session with another instruction instead of starting a new '
      + 'one: the child keeps its own history, todo list, and working directory. Use it to answer a '
      + 'worker that stopped to ask something, or to extend work it already did in this partition.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'text'],
      properties: {
        task_id: { type: 'string', description: 'Task whose worker session should continue.' },
        text: { type: 'string', description: 'The follow-up instruction for that same worker.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { task_id: string; text: string }
      if (exec.agent !== undefined) lastCaller = exec.agent
      const task = board.get(args.task_id)
      if (task === undefined) throw new Error(`unknown task "${args.task_id}"`)
      if (task.sessionId === undefined) {
        throw new Error(`${task.id} has no worker session yet; retry it or publish a new task`)
      }
      // This is the "insert into a session that is already running" path, so it is
      // the one place the worker's own history, not the caller's, decides.
      const refused = await attachRefusal(task.sessionId, 'That worker session')
      if (refused !== undefined) {
        throw new Error(`${refused} Publish a new task for this work, or do it yourself.`)
      }
      const sender = exec.agent ?? liveAgent(task.dispatchFrom) ?? lastCaller
      if (sender === undefined) throw new Error('task_resume needs a live agent to own the delivery')
      const messageId = await continueWorker(ctx.get('subagents')!, sender, task.sessionId, args.text, exec.signal)
      const updated = await board.patch(task.id, { state: 'running', reportedTo: sender.id })
      await publishSnapshot().catch(() => {})
      return {
        text: `${updated.id} continued (session ${task.sessionId}, message ${messageId}). `
          + 'The row returns to `reported` from its session log when the worker stops, because a resumed '
          + 'session has no activation handle in this process.',
      }
    },
  }))

  ctx.effect(() => ctx.tools.register({
    name: 'task_suspend',
    description: 'Suspend a task until a prerequisite is done, then continue it in its own session. '
      + 'A worker that finds it cannot finish because something else must happen first calls this on its '
      + 'own task id with `prerequisite` describing that work, then ends its turn. A human (via the chat) '
      + 'can also suspend any task, even one already delivered, to have it finished later. The router '
      + 'creates the prerequisite task, waits for it (or for `wait_for` ids), and wakes the suspended '
      + 'task with the prerequisite\'s result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['task_id', 'reason'],
      properties: {
        task_id: { type: 'string', description: 'The task to suspend (a worker passes its own task id).' },
        reason: { type: 'string', description: 'Why it cannot be finished now, in one or two sentences.' },
        prerequisite: {
          type: 'string',
          description: 'Self-contained instruction for the prerequisite work. The router publishes it as a new '
            + 'task (same partition unless `partition` says otherwise) and continues this task once it is done.',
        },
        partition: { type: 'string', description: 'Partition for the prerequisite, when it belongs elsewhere.' },
        wait_for: {
          type: 'array',
          items: { type: 'string' },
          description: 'Existing task ids to wait for instead of (or as well as) a new prerequisite.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { task_id: string; reason: string; prerequisite?: string; partition?: string; wait_for?: string[] }
      if (exec.agent !== undefined) lastCaller = exec.agent
      const out = await suspendTask({
        taskId: args.task_id,
        reason: typeof args.reason === 'string' ? args.reason : '',
        ...args.prerequisite === undefined ? {} : { prerequisite: args.prerequisite },
        ...args.partition === undefined ? {} : { partition: args.partition },
        ...args.wait_for === undefined ? {} : { waitFor: args.wait_for },
        ...exec.agent === undefined ? {} : { caller: exec.agent },
      })
      return { text: out.text }
    },
  }))

  /** Longest one `task_wait` call blocks; the caller loops for longer waits. */
  const MAX_WAIT_SECONDS = 900

  ctx.effect(() => ctx.tools.register({
    name: 'task_wait',
    description: 'Wait for tasks that are not running yet: ones held by a stage or depends_on, suspended ones, '
      + 'and ones still queued. Returns as soon as any watched task changes state, when all of them are '
      + 'settled, or after the timeout, with one line per task. A manager passes its own task id as '
      + '`parent_task` to watch all of its tasks, including ones started later.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        parent_task: { type: 'string', description: 'Watch every task under this parent.' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Watch these tasks.' },
        timeout_seconds: { type: 'integer', minimum: 5, maximum: MAX_WAIT_SECONDS, description: 'Default 300.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'settled'],
        properties: { text: { type: 'string' }, settled: { type: 'boolean' } },
      },
      render: (_args, value) => [{ type: 'text', text: (value as { text: string }).text }],
    },
    isConcurrencySafe: () => true,
    async execute(raw, exec: ToolRunContext) {
      const args = raw as { parent_task?: string; task_ids?: string[]; timeout_seconds?: number }
      if (args.parent_task === undefined && (args.task_ids === undefined || args.task_ids.length === 0)) {
        throw new Error('task_wait needs parent_task or task_ids')
      }
      const watched = (): readonly RouterTask[] => {
        const ids = new Set(args.task_ids ?? [])
        if (args.parent_task !== undefined) for (const child of board.childrenOf(args.parent_task)) ids.add(child.id)
        return [...ids].flatMap(id => board.get(id) ?? [])
      }
      // Blocked needs a human: waiting for it would only run out the clock.
      const settled = (task: RouterTask): boolean => !stillComing(task.state)
      const timeout = Math.min(MAX_WAIT_SECONDS, Math.max(5, args.timeout_seconds ?? 300)) * 1000
      const before = new Map(watched().map(task => [task.id, task.state]))
      const started = Date.now()
      let lastFold = Date.now()
      let reason = 'timeout'
      while (Date.now() - started < timeout) {
        if (exec.signal.aborted) { reason = 'aborted'; break }
        const now = watched()
        if (now.length > 0 && now.every(settled)) { reason = 'all settled'; break }
        if (now.some(task => before.get(task.id) !== task.state)) { reason = 'changed'; break }
        // Resumed rows settle only through a log fold; do one now and then.
        if (Date.now() - lastFold > 10_000) {
          lastFold = Date.now()
          await publishSnapshot().catch(() => {})
          await afterChange().catch(() => {})
        }
        await new Promise(done => setTimeout(done, 500))
      }
      const rows = watched()
      const all = rows.length > 0 && rows.every(settled)
      const lines = rows.map((task) => {
        const gate = task.state === 'queued' ? orderGate(task) : READY
        const waits = gate.kind === 'wait' ? ` (waiting for ${gate.on.join(', ')})` : ''
        const said = task.summary ?? (isFinished(task.state) || isDead(task.state) ? task.result : undefined)
        const extra = task.state === 'suspended'
          ? ` suspended: ${task.suspendReason ?? ''}${(task.waitingOn?.length ?? 0) > 0 ? `; waiting for ${task.waitingOn!.join(', ')}` : ''}`
          : task.state === 'blocked' ? ` blocked: ${task.resumeNote ?? ''}` : ''
        return `${mark(task.state)} ${task.id} ${task.state}${waits}${extra} | ${task.subject}`
          + (said === undefined ? '' : `\n    ${tail(said.replace(/\s+/g, ' '), 300)}`)
          + (task.error === undefined ? '' : `\n    error: ${task.error}`)
      })
      return {
        settled: all,
        text: [
          `${reason}; ${all ? 'every watched task is settled: write your consolidated report now' : 'some tasks are still to come: call task_wait (or wait_agent) again'}`,
          ...lines,
        ].join('\n'),
      }
    },
  }))

  // Optional in-process handle for a host-side bridge. The JSON snapshot is the
  // guaranteed contract; this only saves a file read when cordis offers `set`.
  const service = {
    snapshot: (_request?: { partition?: string }) => publishSnapshot(),
    task: async (taskId: string): Promise<TaskView | undefined> =>
      (await publishSnapshot()).tasks.find(task => task.id === taskId),
    snapshotPath,
  }
  if (typeof ctx.set === 'function') {
    try {
      ctx.set('hostRouter', service)
      ctx.logger.info('host-router: published ctx.hostRouter { snapshot, task, snapshotPath }')
    } catch (error) {
      ctx.logger.warn(`host-router: could not publish ctx.hostRouter: ${String(error)}`)
    }
  }

  // --- HTTP bridge for the Web client ---------------------------------------
  //
  // The panel runs in the browser and cannot reach this process's services, so
  // the same facts are published over the one seam both halves already share:
  // the web server that serves the shell. `ctx.inject` is what makes the mount
  // independent of activation order — the callback runs as soon as `webServer`
  // is available, and its routes are disposed with the plugin.
  const bridgeDeps: BridgeDeps = {
    logger: ctx.logger,
    partitions: partitions.map(partition => ({
      name: partition.name,
      dir: partition.dir,
      slots: partition.slots,
      managerEnabled: partition.managerEnabled,
      ...partition.quick === true ? { quick: true } : {},
      ...partition.include === undefined ? {} : { include: partition.include },
      ...partition.exclude === undefined ? {} : { exclude: partition.exclude },
      ...partition.description === undefined ? {} : { description: partition.description.replace(/\s+/g, ' ').trim() },
    })),
    files: async (name, path) => {
      const partition = partitions.find(entry => entry.name === name)
      if (partition === undefined) throw new BridgeError(404, 'not-found', `unknown partition "${name}"`)
      // Its root is the home directory: the panel does not browse that.
      if (partition.quick === true) throw new BridgeError(404, 'not-found', '快任务没有工作区文件')
      try {
        return await listPartitionDir(partition, path)
      } catch (error) {
        if (error instanceof FileListError) throw new BridgeError(error.status, error.code, error.message)
        throw error
      }
    },
    desk: {
      approvals: async () => {
        await outlets.expire()
        return { pending: outlets.pending(), recent: outlets.list().filter(item => item.state !== 'pending').slice(0, 30) }
      },
      decide: (id, decision, note) => decideApproval(id, decision, note),
      audit: async limit => ({ entries: await outlets.recentAudit(limit) }),
      live: (taskId, after) => liveOutput(taskId, after),
      reassign: input => reassignTask(input),
      batch: (taskIds, action, value) => batchControl(taskIds, action, value),
    },
    memory: {
      read: async (name) => {
        const partition = partitions.find(entry => entry.name === name)
        if (partition === undefined) throw new BridgeError(404, 'not-found', `unknown partition "${name}"`)
        const doc = await memory.read(name)
        const route = await managerRoute().catch(() => ({ source: 'inherit' as const }))
        return {
          partition: name,
          notes: doc.notes,
          log: [...doc.log].reverse().slice(0, 60),
          logTotal: doc.log.length,
          sessions: board.inPartition(name)
            .filter(task => task.level === 'worker' && task.sessionId !== undefined)
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
            .slice(0, 40)
            .map(task => ({
              taskId: task.id,
              sessionId: task.sessionId!,
              state: task.state,
              subject: task.subject,
              updatedAt: task.updatedAt,
              ...task.summary === undefined ? {} : { summary: task.summary },
            })),
          manager: {
            enabled: partition.managerEnabled,
            source: route.source,
            ...'route' in route && route.route !== undefined ? { route: route.route } : {},
          },
        }
      },
      addNote: async (name, text) => {
        if (!partitions.some(entry => entry.name === name)) throw new BridgeError(404, 'not-found', `unknown partition "${name}"`)
        try {
          return await memory.addNote(name, text, 'human')
        } catch (error) {
          throw new BridgeError(400, 'bad-request', error instanceof Error ? error.message : String(error))
        }
      },
      removeNote: async (name, id) => {
        if (!partitions.some(entry => entry.name === name)) throw new BridgeError(404, 'not-found', `unknown partition "${name}"`)
        if (!await memory.removeNote(name, id)) throw new BridgeError(404, 'not-found', `no note ${id} in ${name}`)
        return { ok: true, id }
      },
    },
    problems: () => configProblems,
    isEnabled,
    snapshot: () => publishSnapshot(),
    publish: publishDemands,
    anchor: anchorSession,
    verify: decideFromPanel,
    control: controlFromPanel,
    setPartitionState,
    credentials: credentialStatus,
    // Every board mutation rewrites this file, so its mtime is the change signal
    // the SSE route watches. No second bookkeeping to drift.
    changeFile: join(boardDir, 'board.json'),
    tiers: tierFace,
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        ctx.logger.warn('host-router: webServer exposes no register(); the HTTP bridge is not mounted')
        return
      }
      for (const route of createRoutes(bridgeDeps)) {
        const guarded = requireLogin(route, () => ctx.get('connection') as LoginCheck | undefined)
        webCtx.effect(() => webServer.register(guarded), `host-router: ${route.path}`)
      }
      ctx.logger.info(`host-router: HTTP bridge mounted at ${BRIDGE_BASE} (board/publish/anchor/verify/control/partition/tiers/files/events)`)
    })
  } else {
    ctx.logger.info('host-router: this context has no ctx.inject; the HTTP bridge is not mounted (tools only)')
  }

  // --- Resume after a restart ------------------------------------------------
  //
  // A row the previous process left in flight is `interrupted` (board.ts
  // reconcile, or `finish` while stopping). Its session log is intact, so the
  // same session is restored with `sendMessage` (cold resume from the durable
  // log) and told to continue from its own todo list. Managers go first so a
  // resumed worker's closing report has a live parent to land in.

  /** Most resumes one row gets before it is left for a human. */
  const MAX_RESUMES = 3
  const RESUME_TEXT = [
    '【系统通知】DSH 进程刚刚重启，你上一轮的执行被中断了。你的会话历史和 todo 列表都还在。',
    '请先看你的 todo 列表，从中断的那一步继续，已经完成的步骤不要重做。',
    '如果你是 manager：你派出的 worker 也会被逐个恢复，它们会照常把结果报给你；',
    '用 wait_agent 等待即可，不要把同样的工作重新派一遍。',
  ].join('\n')
  /** Rows resumed in this process that have no activation handle to settle them. */
  const resumedRows = new Set<string>()
  let settleTimer: ReturnType<typeof setInterval> | undefined

  /** Settle resumed rows from their logs (the snapshot does it) until none is left. */
  const watchResumed = (): void => {
    if (settleTimer !== undefined) return
    settleTimer = setInterval(() => {
      void (async () => {
        await publishSnapshot().catch(() => {})
        for (const id of [...resumedRows]) {
          const row = board.get(id)
          if (row === undefined || (row.state !== 'running' && row.state !== 'dispatched')) resumedRows.delete(id)
        }
        if (resumedRows.size === 0 && settleTimer !== undefined) {
          clearInterval(settleTimer)
          settleTimer = undefined
        }
      })()
    }, 15_000)
    settleTimer.unref?.()
    ctx.effect(() => () => {
      if (settleTimer !== undefined) clearInterval(settleTimer)
      settleTimer = undefined
    }, 'host-router: resume settle timer')
  }

  /**
   * Resume one interrupted row in its own session.
   * @returns what happened, for the boot log.
   */
  const resumeRow = async (task: RouterTask, sender: LiveAgent, text: string = RESUME_TEXT): Promise<string> => {
    if (task.sessionId === undefined) {
      await board.patch(task.id, { state: 'queued' })
      return `${task.id}: no session, re-queued`
    }
    // A child that finished just before the stop needs no second turn. A blocked
    // row is the exception: a human decided, so the worker must hear it even when
    // its last turn ended normally (e.g. it stopped to ask).
    const facts = foldWorkerLog(await readLog(task.sessionId))
    if (task.state !== 'blocked' && facts.endedWith === 'completed' && facts.lastAssistant !== undefined) {
      await board.patch(task.id, { state: 'done', result: facts.lastAssistant })
      return `${task.id}: already completed in its log, closed`
    }
    const resumes = (task.resumes ?? 0) + 1
    if (resumes > MAX_RESUMES) {
      await board.patch(task.id, { state: 'failed', error: `interrupted ${String(MAX_RESUMES)} times; resume it by hand (task_control resume) or retry` })
      return `${task.id}: resume limit reached`
    }
    await continueWorker(ctx.get('subagents')!, sender, task.sessionId, text, AbortSignal.timeout(60_000))
    await board.patch(task.id, { state: 'running', resumes, runToken, reportedTo: sender.id })
    resumedRows.add(task.id)
    watchResumed()
    return `${task.id}: resumed session ${task.sessionId} (resume ${String(resumes)})`
  }

  /** Resume every interrupted row, managers first, then drive the queues. */
  const resumeInterrupted = async (): Promise<void> => {
    const waiting = board.list()
      .filter(task => task.state === 'interrupted')
      .sort((left, right) => (left.level === right.level ? 0 : left.level === 'manager' ? -1 : 1)
        || Date.parse(left.createdAt) - Date.parse(right.createdAt))
    const hasQueued = board.list().some(task => task.state === 'queued')
    if (waiting.length === 0 && !hasQueued) return
    const anchor = await ensureAnchor()
    if (anchor === undefined) {
      ctx.logger.warn(`host-router: ${String(waiting.length)} interrupted task(s) wait for a live anchor; nothing resumed`)
      return
    }
    for (const task of waiting) {
      try {
        ctx.logger.info(`host-router: ${await resumeRow(task, anchor)}`)
      } catch (error) {
        ctx.logger.warn(`host-router: resuming ${task.id} failed: ${String(error)}`)
        await board.patch(task.id, { state: 'failed', error: `resume after restart failed: ${String(error)}` }).catch(() => {})
      }
    }
    for (const partition of partitions) await pump(partition.name, anchor).catch(() => {})
    await publishSnapshot().catch(() => {})
  }

  // Off the boot path: agents, sessions and the subagent manager must be up first.
  const resumeTimer = setTimeout(() => {
    void resumeInterrupted().catch((error: unknown) => {
      ctx.logger.warn(`host-router: resume after restart failed: ${String(error)}`)
    })
  }, config.resumeDelayMs ?? 8_000)
  resumeTimer.unref?.()
  ctx.effect(() => () => { clearTimeout(resumeTimer) }, 'host-router: resume timer')

  ctx.logger.info(
    `host-router: ${String(partitions.length)} partition(s), board ${join(boardDir, 'board.json')}, `
    + `${String(board.list().filter(task => task.state === 'queued').length)} queued task(s)`,
  )
}

/** Exported so a deployment or test can validate config without booting the plugin. */
export { normalisePartitions, resolveRoute }
export type { RouterConfig, Partition, RouterTask, TaskState, RouterSnapshot, TaskView }
