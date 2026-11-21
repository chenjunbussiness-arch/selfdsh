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
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_CREDENTIAL_REFS, PartitionConfigError, normalisePartitions, partitionBrief, resolveRoute, resolveRouteSmart, } from "./config.js";
import { formatTokens, pressureTokensOf } from "./context.js";
import { parseWorkerReport } from "./report.js";
import { INTERRUPTED_NOTE, TaskBoard, mark, nextTaskId, summarize, tail } from "./board.js";
import { cancelWorker, continueWorker, runVerify, startWorker, textOf } from "./dispatch.js";
import { buildSnapshot, createLogReader, foldWorkerLog } from "./snapshot.js";
import { BRIDGE_BASE, BridgeError, createRoutes, credentialSourceOf } from "./bridge.js";
import { randomUUID } from 'node:crypto';
import { TIERS, TierStore, classifyTier, defaultTiers, isTier, normaliseSettings } from "./tier.js";
/** Stable plugin name. */
export const name = 'host-router';
/** The tool registry and the subagent seam are hard dependencies. */
export const inject = ['tools', 'subagents'];
/** Default concurrent workers per partition. */
const DEFAULT_SLOTS = 2;
/** Default process-wide concurrent worker cap. */
const DEFAULT_MAX_WORKERS = 8;
/** Default acceptance timeout: ten minutes. */
const DEFAULT_VERIFY_TIMEOUT = 600_000;
/** Default delegation-depth cap: a worker may delegate once, no deeper. */
const DEFAULT_MAX_DEPTH = 2;
/** Normalise task text for a pass-through comparison (whitespace and case). */
function normaliseBody(text) {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
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
function relayWarning(body, children) {
    if (children.length !== 1)
        return undefined;
    const child = children[0];
    if (child === undefined)
        return undefined;
    const mine = normaliseBody(body);
    const theirs = normaliseBody(child.body);
    if (mine === '' || theirs === '')
        return undefined;
    const relayed = theirs.includes(mine) || (mine.includes(theirs) && theirs.length > mine.length * 0.8);
    return relayed
        ? 'manager relayed the request unchanged to a single worker (no split); the manager level added no decomposition'
        : undefined;
}
/** Text a manager child receives in place of a worker brief. */
function managerPrompt(input) {
    return [
        `You are the manager of the "${input.partition.name}" partition of this workspace.`,
        `Its files live under ${input.partition.dir}; that is the scope you direct.`,
        '',
        'Your role is dispatch only. You are level 2 of the router: the router already chose this partition,',
        'and your job is to hand the work to workers. Hard rules:',
        '- Do NOT edit, create, or delete any file. Do NOT run bash, shell, or build commands. Do NOT do the',
        '  task yourself, even when it looks small or read-only: a worker does it.',
        '- You MUST start at least one worker with `route_task` before you answer. A manager that ends without',
        '  starting a worker is marked failed with "manager dispatched no worker".',
        `- Every \`route_task\` call passes partition "${input.partition.name}" and parent_task "${input.taskId}".`,
        '- You are the middle level of a three-level chain: routing (the chat) -> you (manager) -> workers.',
        '  Your value is the split and the coordination, not the relay. Forwarding the whole request to a',
        '  single worker is a failure of this role even when one worker could technically do it.',
        '- **Split rule**: count the deliverables in the request. Two or more deliverables (different artifacts,',
        '  different files/areas, different phases such as "investigate then fix then verify") MUST become two or',
        '  more workers. Only a genuinely atomic request may use one worker, and then the worker text must still be',
        '  a narrowed brief, not the raw request copied over.',
        '- **Never copy the whole request into a worker**: give each worker only its slice plus the context it',
        '  needs. If a worker would need everything, the split is wrong.',
        '- Start independent workers in the SAME turn (several `route_task` calls, no `wait_agent` in between);',
        '  there is no worker cap to save. Each worker text must be self-contained: the worker has none of this',
        '  context.',
        '',
        '- Keep a checklist with `todo_write`: before the first `route_task` write the split plan (one step per',
        '  worker plus a final consolidate step); update it each time you start a worker and each time a worker',
        '  reports back. Exactly one step in_progress at a time; mark all completed before your answer.',
        '',
        'Steps:',
        '1. Split the request into self-contained pieces (do not invent work), applying the split rule above.',
        '2. For each piece, decide whether to continue an existing worker or start a new one:',
        '   - you may read `task_board` for this partition: finished rows carry `did` and `touched`;',
        '   - continue with `task_resume` only when a reported row\'s `touched` overlaps the files this piece',
        '     will change; otherwise start a new worker with `route_task`;',
        '   - prefer a new worker when in doubt.',
        '3. Every `route_task` call returns immediately. After starting the workers, call `wait_agent` (repeat',
        '   it as often as needed) until EVERY worker you started has reported back. Do not end your turn before',
        '   that: your closing message is what the dispatcher receives, and a worker report that arrives after',
        '   you have ended is lost.',
        '   A worker that ended failed or aborted must be handled, not ignored: re-dispatch that piece with a',
        '   narrower brief (`route_task`) or retry the same row (`task_control` with action `retry`). Only give up',
        '   after a retry also fails, and say so explicitly in your answer.',
        '4. Then answer with one consolidated report written for the human, in the request\'s language:',
        '   what was done, how it was done, the results (concrete facts the workers observed), and every',
        '   artifact and screenshot path the workers gave, copied verbatim as absolute paths. Do not invent',
        '   facts and do not drop paths. There is no acceptance step: this report is the answer.',
        '',
        ...input.contextLimit > 0
            ? [`Delegation stops at ${formatTokens(input.contextLimit)} prompt tokens; if a dispatch is refused for`,
                'that reason, say so in your answer instead of doing the work yourself.']
            : [],
        '',
        `--- request ${input.taskId} ---`,
        input.body,
    ].join('\n');
}
/** Compose the text one worker receives: partition brief, then the task body. */
function workerPrompt(partition, taskId, body, autoVerify) {
    return `${partitionBrief(partition, { verify: autoVerify, taskId })}\n\n---\n\nTask ${taskId}:\n${body}`;
}
/** Title of the router's chat-facing anchor Session. */
const ANCHOR_TITLE = '作战室';
/**
 * Standing instructions of the anchor ("作战室") Session: a dispatcher that
 * chats with the human, hands work to partitions, and relays the reports.
 */
function anchorInstructions(partitions) {
    return [
        `# 你是「${ANCHOR_TITLE}」`,
        '你是用户的唯一对话入口和调度员。用户像平常聊天一样告诉你要做的事；需要动手的，你派给对应分区去做；',
        '做完后，你用正常聊天的口吻告诉用户做了什么、怎么做的、结果是什么。',
        '',
        '## 分区',
        ...partitions.map(partition => `- ${partition.name}: ${partition.dir}`
            + (partition.description === undefined ? '' : ` — ${partition.description.replace(/\s+/g, ' ').trim()}`)),
        '',
        '## 规则',
        '1. 闲聊、问答、解释、介绍你能做什么，以及靠对话本身就能回答的问题：直接回答，不要派任务。',
        '2. 需要动手的事（改代码、跑命令、查看或分析文件、打开网页、截图、部署等）：你处在这条链的第 1 级，',
        '   职责是「路由 + 拆解」，不是把整段需求原样转手。按三步走：',
        '   a. **拆**：把需求拆成若干工作项，每项是一个能独立完成、有明确产物的单元（例如「改后端接口」与「改前端页面」',
        '      是两个工作项；「先查清现状再改」可以是一个工作项）。单点小事才只有一个工作项。',
        '   b. **分配**：每个工作项各自判断属于哪个分区；跨分区的工作项分别派给各自分区。',
        '   c. **派发**：互不依赖的工作项必须在同一轮里连续多次调用 `route_task` 并行派出；有先后依赖的按顺序派。',
        '      不要因为「一个需求」就只派一条——那会把整块工作压成主从式的单线传递。',
        '   - 拆解结果先用 `todo_write` 记下来（每个工作项一步，最后一步汇总），用户能在面板上看到路由计划。',
        '   - 每个 `route_task` 的 `text` 要自包含（执行者看不到这段对话，要带 URL、路径、要求、期望产物），',
        '     但只写这个工作项的范围，不要把整段需求复制过去。',
        '   - 能判断分区就填 `partition`，判断不了就省略，由路由器决定。不要传 `parent_task`。',
        '3. 你自己绝不动手干活：不调用 bash、pwsh、write、edit、apply_patch 等修改文件或执行命令的工具，',
        '   也不要用 web_fetch、browser 之类的工具代替执行者去做任务。可以用 `task_board` / `task_progress` 查进度，',
        '   用 `read` / `read_image` 查看执行者产出的文件和截图。',
        '4. 派出任务后，用一两句话告诉用户交给了哪个分区、任务号是什么，然后结束这一轮。不要等待，不要轮询。',
        '5. 执行结果会作为一条消息回到这个对话（子任务结束的通知，里面是分区 manager 的汇总）。收到后用聊天的口吻回复用户：',
        '   - 做了什么、怎么做的、结果（关键事实，例如页面标题和主要文字）；',
        '   - 有截图时，用 Markdown 图片语法把图直接显示在回复里：`![说明](</截图的绝对路径.png>)`，',
        '     并调用 `present` 工具把截图作为交付文件发布（`files: [{ path, description }]`，path 用绝对路径）；',
        '   - 其他产物用 Markdown 链接写出绝对路径；',
        '   - 失败就如实说明失败在哪里，以及建议的下一步。',
        '   没有验收环节，不要提"验收""待验收"；汇报本身就是结果。',
        '6. 用户追问某个任务的细节时，用 `task_board`（带 task_id）查记录；需要在同一个执行者上继续做，用 `task_resume`。',
    ].join('\n');
}
/** Directory the anchor Session lives in: the partitions' shared parent, else the first root. */
function anchorDirOf(partitions) {
    const parents = [...new Set(partitions.map(partition => dirname(partition.dir)))];
    return parents.length === 1 ? parents[0] : (partitions[0]?.dir ?? process.cwd());
}
/** Deep-freeze a plain value, as the harness does with every published message. */
function deepFreeze(value) {
    if (typeof value === 'object' && value !== null) {
        for (const key of Object.keys(value))
            deepFreeze(value[key]);
        Object.freeze(value);
    }
    return value;
}
/**
 * Build one user-role message the way `dsh-llm` `createUserMessage` does
 * (fresh id, frozen), without importing an `@deepseek-ai` package at runtime.
 */
function userMessage(text) {
    return deepFreeze({
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
        id: randomUUID(),
    });
}
/** Mount the router: partitions, board, tools, and the worker lifecycle. */
export async function apply(ctx, config) {
    const partitions = normalisePartitions(config.partitions, {
        workers: DEFAULT_SLOTS,
        manager: config.manager !== false,
    });
    const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    const boardDir = config.boardDir === undefined ? join(home, 'router') : resolve(config.boardDir);
    const snapshotPath = join(boardDir, 'snapshot.json');
    await mkdir(boardDir, { recursive: true });
    /** Identity of this plugin activation, so a restart can spot its own leftovers. */
    const runToken = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const board = await TaskBoard.open(boardDir, runToken);
    const provider = config.provider ?? 'spawn';
    const maxWorkers = config.maxWorkers ?? DEFAULT_MAX_WORKERS;
    const autoVerify = config.autoVerify !== false;
    const verifyTimeout = config.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT;
    const maxDepth = config.maxDepth ?? DEFAULT_MAX_DEPTH;
    /** Preset for the anchor and for partitions without one; `''` means none. */
    const defaultPreset = config.defaultPreset === '' ? undefined : (config.defaultPreset ?? 'standard');
    const presetOf = (partition) => partition.preset ?? defaultPreset;
    /** Zero disables the guard; otherwise every attach point compares against it. */
    const contextLimit = config.contextLimitTokens ?? DEFAULT_CONTEXT_LIMIT;
    // --- Level 1 routing inputs -------------------------------------------------
    /** Top-level directory names per partition, read once: routing hints for keywords and the LLM. */
    const topDirs = {};
    for (const partition of partitions) {
        try {
            const entries = await readdir(partition.dir, { withFileTypes: true });
            topDirs[partition.name] = entries
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
                .map(entry => entry.name)
                .sort();
        }
        catch (error) {
            topDirs[partition.name] = [];
            ctx.logger.warn(`host-router: cannot list ${partition.dir}: ${String(error)}`);
        }
    }
    const classifierTimeout = config.classifierTimeoutMs ?? 20_000;
    /**
     * One LLM classification call through `ctx.llm`, built without importing
     * `@deepseek-ai/dsh-llm`: the request message is a plain one-shot user input
     * and the answer is the concatenated `text-delta` chunks.
     */
    const classifier = (() => {
        const llm = ctx.get('llm');
        if (llm === undefined || typeof llm.prepareCall !== 'function') {
            ctx.logger.warn('host-router: ctx.llm unavailable; routing falls back to keywords only');
            return undefined;
        }
        return async (request) => {
            const selection = ctx.get('agentDefaultModel')?.currentSelection();
            if (selection === undefined)
                throw new Error('no default model selection (agentDefaultModel)');
            const signal = AbortSignal.timeout(classifierTimeout);
            const call = await llm.prepareCall({ provider: selection.provider, model: selection.model, maxTokens: 1024 }, signal, (controls, model) => {
                // Least reasoning the model offers: classification needs an answer, not a plan.
                const least = model.reasoning?.efforts?.[0]?.id;
                return { ...controls, ...least === undefined ? {} : { reasoningEffort: least } };
            });
            let text = '';
            for await (const chunk of call.stream({
                ...call.config,
                messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }],
                system: request.system,
                signal,
            })) {
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    text += chunk.text;
                else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
                    throw new Error(`model call ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'no message'}`);
                }
            }
            return text;
        };
    })();
    // --- Difficulty tiers --------------------------------------------------------
    const tierStore = await TierStore.open(join(boardDir, 'tiers.json'));
    const llmService = ctx.get('llm');
    /** One short text answer from an explicit route (used by the tier classifier). */
    const tierCall = llmService === undefined || typeof llmService.prepareCall !== 'function'
        ? undefined
        : async (route, system, prompt) => {
            const signal = AbortSignal.timeout(classifierTimeout);
            const call = await llmService.prepareCall({ provider: route.provider, model: route.model, maxTokens: 256 }, signal, (controls, model) => {
                const least = model.reasoning?.efforts?.[0]?.id;
                return { ...controls, ...least === undefined ? {} : { reasoningEffort: least } };
            });
            let text = '';
            for await (const chunk of call.stream({
                ...call.config,
                messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
                system,
                signal,
            })) {
                if (chunk.type === 'text-delta' && typeof chunk.text === 'string')
                    text += chunk.text;
                else if (chunk.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
                    throw new Error(`model call ${chunk.reason.kind}: ${chunk.reason.failure?.message ?? 'no message'}`);
                }
            }
            return text;
        };
    /** Every advertised model, read live so the panel offers what is really routable. */
    const modelOptions = async () => {
        if (llmService?.listProviders === undefined || llmService.listModels === undefined)
            return [];
        const options = [];
        for (const provider of llmService.listProviders()) {
            try {
                for (const model of await llmService.listModels(provider.id)) {
                    let efforts;
                    try {
                        const info = await llmService.resolveModelInfo?.(provider.id, model.id);
                        const ids = info?.reasoning?.efforts?.map(effort => effort.id);
                        if (ids !== undefined && ids.length > 0)
                            efforts = ids;
                    }
                    catch { /* efforts are optional */ }
                    options.push({
                        provider: provider.id,
                        providerName: provider.name,
                        model: model.id,
                        name: model.name,
                        ...efforts === undefined ? {} : { efforts },
                    });
                }
            }
            catch (error) {
                ctx.logger.warn(`host-router: listModels(${provider.id}) failed: ${String(error)}`);
            }
        }
        return options;
    };
    /** Default selection of the profile, as a route. */
    const defaultRoute = () => {
        const selection = ctx.get('agentDefaultModel')?.currentSelection();
        return selection === undefined ? undefined : {
            provider: selection.provider,
            model: selection.model,
            ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        };
    };
    let cachedOptions;
    const cachedModelOptions = async () => {
        if (cachedOptions !== undefined && Date.now() - cachedOptions.at < 60_000)
            return cachedOptions.value;
        cachedOptions = { at: Date.now(), value: await modelOptions() };
        return cachedOptions.value;
    };
    /** Effective route per tier: saved choice, else the computed default. */
    const effectiveTiers = async () => {
        const saved = tierStore.get().tiers;
        const defaults = defaultTiers(await cachedModelOptions(), defaultRoute());
        return {
            easy: saved.easy ?? defaults.easy,
            medium: saved.medium ?? defaults.medium,
            hard: saved.hard ?? defaults.hard,
        };
    };
    /** Classify one route_task call; never throws. */
    const decideTier = async (args) => {
        if (!tierStore.get().auto && !isTier(args.tier))
            return undefined;
        const easy = (await effectiveTiers()).easy;
        return await classifyTier({ text: args.text, ...args.files === undefined ? {} : { files: args.files }, ...args.tier === undefined ? {} : { tier: args.tier } }, tierCall, easy);
    };
    /** Bridge face: read + write tier settings. */
    const tierFace = {
        read: async () => {
            const settings = tierStore.get();
            const models = await cachedModelOptions();
            const defaults = defaultTiers(models, defaultRoute());
            return {
                auto: settings.auto,
                saved: settings.tiers,
                effective: await effectiveTiers(),
                defaults,
                defaultModel: defaultRoute() ?? null,
                models,
            };
        },
        write: async (body) => {
            const current = tierStore.get();
            const incoming = normaliseSettings({
                auto: typeof body['auto'] === 'boolean' ? body['auto'] : current.auto,
                tiers: (typeof body['tiers'] === 'object' && body['tiers'] !== null
                    ? { ...current.tiers, ...body['tiers'] }
                    : current.tiers),
            });
            // Drop a tier explicitly reset to null.
            const tiers = { ...incoming.tiers };
            const raw = body['tiers'];
            for (const tier of TIERS)
                if (raw !== undefined && raw[tier] === null)
                    delete tiers[tier];
            // Only routes the runtime advertises may be saved.
            const models = await cachedModelOptions();
            if (models.length > 0) {
                for (const tier of TIERS) {
                    const route = tiers[tier];
                    if (route !== undefined && !models.some(option => option.provider === route.provider && option.model === route.model)) {
                        throw new BridgeError(400, 'bad-request', `unknown model route ${route.provider}/${route.model}`);
                    }
                }
            }
            await tierStore.set({ auto: incoming.auto, tiers });
            ctx.logger.info(`host-router: tier settings saved (auto=${String(incoming.auto)})`);
            return await tierFace.read();
        },
    };
    /** Level 1: explicit -> files -> unique keyword score -> LLM -> keyword fallback. */
    const route = async (input) => await resolveRouteSmart(partitions, input, {
        ...config.defaultPartition === undefined ? {} : { fallback: config.defaultPartition },
        ...classifier === undefined ? {} : { classifier },
        topDirs,
        ...config.autoRouteMinScore === undefined ? {} : { minScore: config.autoRouteMinScore },
        timeoutMs: classifierTimeout,
    });
    /**
     * The services this plugin reads, in the order it needs them.
     *
     * Reported once at activation so a version upgrade has one line to read: a
     * seam that vanished shows up as `absent` here instead of as a failure three
     * tasks later. `webServer` is checked separately — it can arrive after this
     * runs, and the `ctx.inject` below logs its own outcome.
     */
    const SEAMS = ['tools', 'subagents', 'agents', 'sessionQuery', 'credentials', 'sandboxPolicy'];
    /**
     * Whether one service is reachable.
     *
     * `ctx.get` is the safe lookup, but a service this plugin injects also exists
     * as a plain property, and the two do not always agree (a host may expose the
     * injected pair without making them retrievable by name). A report that says
     * `tools=absent` while the plugin is registering tools would be worse than no
     * report, so both spellings are tried.
     */
    const seamPresent = (name) => {
        if (ctx.get(name) !== undefined)
            return true;
        try {
            return ctx[name] !== undefined;
        }
        catch {
            return false;
        }
    };
    ctx.logger.info('host-router seams: ' + SEAMS
        .map(name => `${name}=${seamPresent(name) ? 'ok' : 'absent'}`)
        .join(' '));
    // The logger does not necessarily reach the process log (on a `dsh web`
    // service it is swallowed), so the same report also lands in a file an operator
    // can read after an upgrade: `<dsh home>/router/seams.json`.
    const seamReport = {};
    for (const name of SEAMS)
        seamReport[name] = seamPresent(name);
    /** Seams without which the plugin cannot dispatch anything at all. */
    const REQUIRED_SEAMS = ['tools', 'subagents'];
    await writeFile(join(boardDir, 'seams.json'), JSON.stringify({
        at: new Date().toISOString(),
        node: process.version,
        seams: seamReport,
        required: REQUIRED_SEAMS,
        ok: REQUIRED_SEAMS.every(name => seamReport[name] === true),
    }, undefined, 2), 'utf8').catch((error) => {
        ctx.logger.warn(`host-router: could not write seams.json: ${String(error)}`);
    });
    let sequence = board.list().length;
    /** Most recent human-facing agent, used when a queued task's own dispatcher is gone. */
    let lastCaller;
    /** Activations started by this process, keyed by task id. */
    const inFlight = new Map();
    /** Partition names whose pump loop is running; prevents double dispatch. */
    const pumping = new Set();
    /**
     * True once this process is shutting down (SIGTERM/SIGINT) or this plugin is
     * being disposed. A child that ends while it is set was stopped by the harness,
     * not by its own work, so its row becomes `interrupted` and is resumed from its
     * log on the next boot instead of being recorded as failed.
     */
    let stopping = false;
    const markStopping = () => { stopping = true; };
    process.once('SIGTERM', markStopping);
    process.once('SIGINT', markStopping);
    ctx.effect(() => () => {
        stopping = true;
        process.off('SIGTERM', markStopping);
        process.off('SIGINT', markStopping);
    }, 'host-router: shutdown marker');
    const partitionOf = (task) => {
        const found = partitions.find(entry => entry.name === task.partition);
        if (found === undefined) {
            throw new PartitionConfigError(`board references unknown partition "${task.partition}"`);
        }
        return found;
    };
    /**
     * Whether a partition's operator switch is on.
     *
     * Absent means enabled, so a board written before this switch existed needs no
     * migration.
     */
    const isEnabled = (name) => board.partitionRecord(name).disabled !== true;
    const liveAgent = (id) => {
        if (id === undefined)
            return undefined;
        return ctx.get('agents')?.get(id);
    };
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
    const anchorFile = join(boardDir, 'anchor.json');
    /** The anchor's session id: read from disk, or minted on first creation. */
    let anchorSessionId = await readFile(anchorFile, 'utf8')
        .then(text => JSON.parse(text).sessionId)
        .then(id => (typeof id === 'string' && id !== '' ? id : undefined))
        .catch(() => undefined);
    let anchorPending;
    /** Agents (by object) that already carry the dispatcher instructions. */
    const instructed = new WeakSet();
    /** Give one anchor Agent its dispatcher instructions as a per-agent system section. */
    const instructAnchor = (agent) => {
        if (instructed.has(agent))
            return;
        const prompt = agent.ctx?.systemPrompt;
        if (prompt === undefined || typeof prompt.section !== 'function') {
            ctx.logger.warn('router: anchor agent exposes no ctx.systemPrompt; dispatcher instructions not installed');
            return;
        }
        try {
            prompt.section({
                name: 'router:anchor-dispatcher',
                // After the deployment persona suffix, so it is the last word.
                order: (prompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX') ?? 10_200) + 50,
                text: anchorInstructions(partitions),
            });
            instructed.add(agent);
        }
        catch (error) {
            ctx.logger.warn(`router: could not install anchor instructions: ${String(error)}`);
        }
    };
    // Whoever makes the anchor live — this plugin, or the session controller when
    // the user opens it from the Sidebar after a restart — it gets the same
    // instructions, so chatting there and posting from the panel behave alike.
    ctx.on('agent/created', ((payload) => {
        const agent = payload?.agent;
        if (agent !== undefined && anchorSessionId !== undefined && agent.id === anchorSessionId)
            instructAnchor(agent);
    }));
    const persistAnchor = async (sessionId) => {
        await writeFile(anchorFile, JSON.stringify({ sessionId, title: ANCHOR_TITLE, at: new Date().toISOString() }, undefined, 2), 'utf8')
            .catch((error) => { ctx.logger.warn(`router: could not persist ${anchorFile}: ${String(error)}`); });
    };
    const ensureAnchor = async (_cwd) => {
        const agents = ctx.get('agents');
        const create = agents?.create;
        if (agents === undefined || create === undefined)
            return undefined;
        if (anchorSessionId !== undefined) {
            const live = agents.get(anchorSessionId);
            if (live !== undefined) {
                instructAnchor(live);
                return live;
            }
        }
        if (anchorPending !== undefined)
            return await anchorPending;
        anchorPending = (async () => {
            try {
                const selection = ctx.get('agentDefaultModel')?.currentSelection();
                const agentOptions = selection === undefined
                    ? undefined
                    : {
                        provider: selection.provider,
                        model: selection.model,
                        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
                    };
                const presets = ctx.get('agentPresets');
                let presetId;
                if (presets !== undefined && defaultPreset !== undefined) {
                    try {
                        presetId = (await presets.resolve(defaultPreset)).id;
                    }
                    catch (error) {
                        ctx.logger.warn(`router: anchor preset "${defaultPreset}" unavailable, creating without one: ${String(error)}`);
                    }
                }
                const setup = presets === undefined || presetId === undefined
                    ? undefined
                    : async (agentCtx) => { await presets.mount(agentCtx, presetId); };
                // 1. Resume the persisted conversation.
                if (anchorSessionId !== undefined && typeof agents.resume === 'function') {
                    try {
                        const handle = await agents.resume.call(agents, {
                            resumeSessionId: anchorSessionId,
                            ...(agentOptions === undefined ? {} : { agentOptions }),
                            ...(setup === undefined ? {} : { setup }),
                        });
                        ctx.effect(() => () => { void handle.dispose(); }, 'router: anchor agent');
                        instructAnchor(handle.agent);
                        ctx.logger.info(`router: resumed anchor session ${anchorSessionId}`);
                        return handle.agent;
                    }
                    catch (error) {
                        // Someone else (the session controller) may have just made it live.
                        const live = agents.get(anchorSessionId);
                        if (live !== undefined) {
                            instructAnchor(live);
                            return live;
                        }
                        ctx.logger.warn(`router: cannot resume anchor ${anchorSessionId}, creating a new one: ${String(error)}`);
                    }
                }
                // 2. Create a new one.
                const sessionId = `session-${randomUUID()}`;
                anchorSessionId = sessionId;
                const handle = await create.call(agents, {
                    sessionId,
                    meta: { cwd: anchorDirOf(partitions), ...(presetId === undefined ? {} : { agentPreset: presetId }) },
                    ...(setup === undefined ? {} : { setup }),
                    ...(agentOptions === undefined ? {} : { agentOptions }),
                });
                ctx.effect(() => () => { void handle.dispose(); }, 'router: anchor agent');
                instructAnchor(handle.agent);
                await persistAnchor(sessionId);
                const titles = ctx.get('sessionTitle');
                try {
                    titles?.rename?.(handle.agent.session, ANCHOR_TITLE);
                }
                catch (error) {
                    ctx.logger.warn(`router: could not title the anchor session: ${String(error)}`);
                }
                ctx.logger.info(`router: created anchor session ${sessionId}`);
                return handle.agent;
            }
            catch (error) {
                ctx.logger.warn(`router: cannot create an anchor agent: ${String(error)}`);
                return undefined;
            }
            finally {
                anchorPending = undefined;
            }
        })();
        return await anchorPending;
    };
    /**
     * Attach a demand that has no producing Agent to a live one.
     *
     * `startActivation` requires the exact live parent, so a demand posted from the
     * board — whose HTTP request carries no Agent at all — could never start: the
     * pump found no `dispatchFrom` owner, no tool-call caller and no `lastCaller`,
     * and returned while the row stayed queued forever.
     * @returns a live Agent, or undefined when the harness cannot provide one.
     */
    const anyLiveAgent = async (cwd) => {
        const query = ctx.get('sessionQuery');
        const agents = ctx.get('agents');
        if (query !== undefined && agents !== undefined) {
            try {
                const records = await query.listSessions();
                for (const record of [...records].reverse()) {
                    const agent = agents.get(record.id);
                    if (agent !== undefined)
                        return agent;
                }
            }
            catch (error) {
                ctx.logger.warn(`router: cannot scan for a live agent: ${String(error)}`);
            }
        }
        return await ensureAnchor(cwd);
    };
    /**
     * Pick the parent for one queued row.
     *
     * Recorded owner first (a row keeps its producing Agent when that Agent is
     * still alive), then the current tool-call caller, then the last caller seen,
     * then any live Session, then the Router's own anchor.
     */
    const resolveParent = async (task, caller) => {
        const recorded = liveAgent(task.dispatchFrom) ?? caller ?? lastCaller;
        if (recorded !== undefined)
            return recorded;
        const root = partitions.find(entry => entry.name === task.partition)?.dir;
        return await anyLiveAgent(root ?? process.cwd());
    };
    /** A row occupies a slot only while a real child could still be running. */
    const holdsSlot = (task) => {
        if (task.state !== 'running' && task.state !== 'dispatched')
            return false;
        return inFlight.has(task.id) || liveAgent(task.sessionId) !== undefined;
    };
    /** Workers, not managers: managers are control entities with their own cap. */
    const runningCount = (partition) => board.inPartition(partition).filter(task => task.level === 'worker' && holdsSlot(task)).length;
    const totalRunning = () => board.list().filter(task => task.level === 'worker' && holdsSlot(task)).length;
    /** Whether the router-side worker caps are reached; `0` means that cap is off. */
    const workersFull = (partition) => (maxWorkers > 0 && totalRunning() >= maxWorkers)
        || (partition.slots > 0 && runningCount(partition.name) >= partition.slots);
    const readLog = createLogReader(ctx.get('sessionQuery'), ctx.logger);
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
    const attachRefusal = async (sessionId, role) => {
        if (contextLimit <= 0)
            return undefined;
        const used = pressureTokensOf(await readLog(sessionId));
        if (used === undefined || used <= contextLimit)
            return undefined;
        return `${role} is at ${formatTokens(used)} prompt tokens, past the ${formatTokens(contextLimit)} `
            + 'attach ceiling. Another turn there would re-read more history than it can still reason over, '
            + 'so the router does not hand it more work.';
    };
    /**
     * Rebuild the one UI document and persist it. Concurrent callers (several
     * open panels, SSE refreshes) share the build already in flight instead of
     * each starting a full pass over every worker log.
     */
    // A caller that arrives mid-build may have just changed the board, so it
    // waits for one follow-up build rather than the stale one; all callers that
    // arrive during the same build share that single follow-up.
    let snapshotInFlight;
    let snapshotQueued;
    const startSnapshot = () => {
        const run = buildAndWriteSnapshot().finally(() => {
            if (snapshotInFlight === run)
                snapshotInFlight = undefined;
        });
        snapshotInFlight = run;
        return run;
    };
    const publishSnapshot = () => {
        if (snapshotInFlight === undefined)
            return startSnapshot();
        if (snapshotQueued === undefined) {
            snapshotQueued = snapshotInFlight.catch(() => undefined).then(() => {
                snapshotQueued = undefined;
                return startSnapshot();
            });
        }
        return snapshotQueued;
    };
    const buildAndWriteSnapshot = async () => {
        const snapshot = await buildSnapshot({
            board,
            partitions,
            sessionQuery: ctx.get('sessionQuery'),
            logger: ctx.logger,
            isLive: task => holdsSlot(task),
            readLog,
            correctState: async (task, change) => {
                await board.patch(task.id, {
                    state: change.state,
                    ...change.result === undefined ? {} : { result: tail(change.result) },
                    ...change.error === undefined ? {} : { error: change.error },
                });
            },
        });
        try {
            await mkdir(dirname(snapshotPath), { recursive: true });
            await writeFile(snapshotPath, JSON.stringify(snapshot, undefined, 2), 'utf8');
        }
        catch (error) {
            ctx.logger.warn(`host-router: could not write ${snapshotPath}: ${String(error)}`);
        }
        return snapshot;
    };
    /** Record a task's terminal state from the worker's own result. */
    const finish = async (taskId, result) => {
        inFlight.delete(taskId);
        const task = board.get(taskId);
        if (task === undefined || (task.state !== 'running' && task.state !== 'dispatched'))
            return;
        const partition = partitionOf(task);
        const report = textOf(result.output);
        // Parsed before the state branch on purpose: a worker that died still changed
        // files, and the decision about reusing this session needs that too.
        const facts = parseWorkerReport(report);
        const described = facts === undefined
            ? {}
            : {
                ...facts.summary === undefined ? {} : { summary: facts.summary },
                touched: facts.touched,
                ...facts.left === undefined ? {} : { left: facts.left },
            };
        if (result.stopReason !== 'completed' && stopping && task.sessionId !== undefined) {
            // Stopped by the harness, not by the work: keep it resumable.
            await board.patch(taskId, { state: 'interrupted', error: INTERRUPTED_NOTE, ...described });
            return;
        }
        if (result.stopReason !== 'completed') {
            await board.patch(taskId, {
                state: 'failed',
                result: tail(report),
                error: `worker ended with stopReason "${result.stopReason}"`,
                ...described,
            });
            await publishSnapshot().catch(() => { });
            return;
        }
        if (task.level === 'manager') {
            // Level 2 contract: a manager dispatches, it does not execute.
            const children = board.childrenOf(task.id);
            if (children.length === 0) {
                await board.patch(taskId, {
                    state: 'failed',
                    result: tail(report),
                    error: 'manager dispatched no worker',
                    ...described,
                });
                await publishSnapshot().catch(() => { });
                return;
            }
            // No acceptance step: a manager that dispatched and ended normally is done.
            const relayed = relayWarning(task.body, children);
            if (relayed !== undefined)
                ctx.logger.warn(`host-router: ${taskId} ${relayed}`);
            const managerResult = relayed === undefined ? tail(report) : `${tail(report)}\n\n[router] ${relayed}`;
            await board.patch(taskId, { state: 'done', result: managerResult, ...described });
            await publishSnapshot().catch(() => { });
            return;
        }
        const commands = task.verify ?? (autoVerify ? partition.verify ?? [] : []);
        if (commands.length === 0) {
            // No acceptance command configured: a normal end is finished.
            await board.patch(taskId, { state: 'done', result: tail(report), ...described });
            await publishSnapshot().catch(() => { });
            return;
        }
        const verdict = await runVerify(commands, partition.dir, verifyTimeout);
        await board.patch(taskId, {
            state: verdict.ok ? 'verified' : 'failed',
            result: tail(report),
            verify: commands,
            verifyOutput: tail(verdict.output),
            ...verdict.ok ? {} : { error: `acceptance failed: ${verdict.failed ?? 'unknown command'}` },
            ...described,
        });
        await publishSnapshot().catch(() => { });
    };
    /** Record a start failure without pretending the task ran. */
    const failStart = async (taskId, error) => {
        inFlight.delete(taskId);
        const message = error instanceof Error ? error.message : String(error);
        if (board.get(taskId) === undefined)
            return;
        await board.patch(taskId, { state: 'failed', error: `dispatch failed: ${message}` });
        await publishSnapshot().catch(() => { });
    };
    /**
     * Start one child for one task and wire its settlement.
     *
     * The parent is re-resolved by the caller rather than captured at enqueue time:
     * a queued task can be pumped minutes later, after the agent that queued it
     * settled and was disposed, and `startActivation` requires the exact live
     * parent.
     */
    const dispatch = async (task, parent) => {
        const partition = partitionOf(task);
        const isManager = task.level === 'manager';
        const prompt = isManager
            ? managerPrompt({ partition, taskId: task.id, body: task.body, contextLimit })
            : workerPrompt(partition, task.id, task.body, autoVerify);
        const label = `${partition.name}/${isManager ? 'manager' : 'worker'}: ${task.subject}`;
        // Tier -> model route, read at dispatch time so a saved change applies to queued rows too.
        let route;
        if (task.tier !== undefined && (tierStore.get().auto || task.tierSource === 'explicit')) {
            try {
                route = (await effectiveTiers())[task.tier];
            }
            catch (error) {
                ctx.logger.warn(`host-router: tier route for ${task.id} unavailable: ${String(error)}`);
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
                ...presetOf(partition) === undefined ? {} : { preset: presetOf(partition) },
                maxDepth,
                // Every child reports to its parent, including the anchor: the anchor is
                // the chat the user reads, and the manager's report is what it relays.
                delivery: 'parent',
            };
            let activation;
            let usedRoute = route;
            try {
                activation = await startWorker(ctx.get('subagents'), {
                    ...startSpec,
                    ...route === undefined ? {} : { agentOptions: route },
                });
            }
            catch (error) {
                if (route === undefined)
                    throw error;
                // A route the runtime rejects must not lose the task: fall back to inheriting.
                ctx.logger.warn(`host-router: ${task.id} could not start on ${route.provider}/${route.model}, inheriting: ${String(error)}`);
                usedRoute = undefined;
                activation = await startWorker(ctx.get('subagents'), startSpec);
            }
            inFlight.set(task.id, activation);
            const parentRoute = parent.session
                .requestHeader?.()?.config;
            const recorded = usedRoute ?? (parentRoute?.provider !== undefined && parentRoute.model !== undefined
                ? { provider: parentRoute.provider, model: parentRoute.model, ...parentRoute.reasoningEffort === undefined ? {} : { reasoningEffort: parentRoute.reasoningEffort } }
                : undefined);
            await board.patch(task.id, {
                ...recorded === undefined ? {} : { provider: recorded.provider, model: recorded.model },
                ...recorded?.reasoningEffort === undefined ? {} : { reasoningEffort: recorded.reasoningEffort },
                ...route !== undefined && usedRoute === undefined ? { tierReason: `${task.tierReason ?? ''} (route rejected, inherited)` } : {},
                ...task.tier === undefined ? { tierSource: 'off' } : {},
            });
            await board.patch(task.id, {
                state: 'dispatched',
                sessionId: activation.childId,
                worker: activation.name,
                dispatchFrom: parent.id,
                reportedTo: parent.id,
                attempts: task.attempts + 1,
                runToken,
            });
            void activation.result.then(result => finish(task.id, result).catch((error) => {
                ctx.logger.warn(`host-router: closing ${task.id} failed: ${String(error)}`);
            }), (error) => failStart(task.id, error).catch(() => { }));
            // In 0.2.2-rc.3 the sandbox's write boundary is `session.header.cwd`, and a
            // child inherits its creator's header cwd — so a worker rooted in another
            // partition needs an explicit write grant. Best effort: the grant is
            // runtime-only (re-registered on every dispatch) and, on Windows, covers
            // harness file tools rather than sandboxed processes. A deployment that
            // needs the guarantee should also set `additionalWritableRoots`.
            const sandboxPolicy = ctx.get('sandboxPolicy');
            if (sandboxPolicy !== undefined) {
                const child = ctx.get('agents')?.get(activation.childId);
                if (child !== undefined) {
                    try {
                        sandboxPolicy.registerWritableRoot(child.session, partition.dir);
                    }
                    catch (error) {
                        ctx.logger.warn(`host-router: could not grant ${partition.dir} to ${activation.childId}: ${String(error)}`);
                    }
                }
            }
            if (isManager) {
                await board.patchPartition(partition.name, {
                    managerSessionId: activation.childId,
                    managerName: activation.name,
                    managerUpdatedAt: new Date().toISOString(),
                });
            }
        }
        catch (error) {
            await failStart(task.id, error);
        }
    };
    /**
     * Start queued tasks while the partition has free slots.
     *
     * Not a background timer on purpose: the pump runs on enqueue and on the tool
     * calls that read the board, so an idle harness holds no scheduled work and a
     * human action is what re-drives a queue left behind by a restart.
     */
    const pump = async (partitionName, caller) => {
        if (pumping.has(partitionName))
            return;
        pumping.add(partitionName);
        try {
            while (true) {
                const partition = partitions.find(entry => entry.name === partitionName);
                if (partition === undefined)
                    return;
                // A disabled partition accepts no new demand and starts nothing; its
                // existing rows keep the state they already reached.
                if (!isEnabled(partitionName))
                    return;
                // Managers are control entities: any number may run at once, one per
                // demand. Only workers count against the (optional) caps.
                const full = workersFull(partition);
                const next = board.inPartition(partitionName)
                    .find(task => task.state === 'queued' && (task.level === 'manager' || !full));
                if (next === undefined)
                    return;
                const parent = await resolveParent(next, caller);
                if (parent === undefined)
                    return;
                await dispatch(next, parent);
            }
        }
        finally {
            pumping.delete(partitionName);
        }
    };
    /** Create one task row and persist it before anything is dispatched. */
    const enqueue = async (input, decision, level, caller, tier) => {
        const now = new Date().toISOString();
        const task = {
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
            attempts: 0,
            createdAt: now,
            updatedAt: now,
        };
        return await board.add(task);
    };
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
    const publishDemands = async (texts) => {
        const lines = texts.map(text => text.trim()).filter(text => text !== '');
        if (lines.length === 0)
            return { accepted: 0, routed: [] };
        const agent = await ensureAnchor();
        if (agent === undefined || typeof agent.followup !== 'function') {
            throw new BridgeError(503, 'unavailable', 'the 作战室 anchor session could not be started');
        }
        const text = lines.join('\n');
        agent.followup(userMessage(text));
        return {
            accepted: lines.length,
            routed: lines.map(line => ({ text: line, reason: `posted to ${ANCHOR_TITLE}` })),
            anchorSessionId: agent.id,
        };
    };
    /** The anchor's session id, creating or resuming it when needed (the panel's "open" button). */
    const anchorSession = async () => {
        const agent = await ensureAnchor();
        if (agent === undefined)
            throw new BridgeError(503, 'unavailable', 'the 作战室 anchor session could not be started');
        return { sessionId: agent.id, title: ANCHOR_TITLE };
    };
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
    const decideFromPanel = async (taskId, verdict, note) => {
        const task = board.get(taskId);
        if (task === undefined)
            throw new BridgeError(404, 'not-found', `unknown task "${taskId}"`);
        if (task.state !== 'reported') {
            throw new BridgeError(409, 'conflict', `${task.id} is "${task.state}"; only a task awaiting verification ("reported") can be judged`);
        }
        const stamp = new Date().toISOString();
        const remark = note === undefined || note.trim() === '' ? undefined : note.trim();
        const notes = [...task.notes ?? []];
        if (verdict === 'verified') {
            notes.push(`verified from the router panel at ${stamp}${remark === undefined ? '' : `: ${remark}`}`);
            const updated = await board.patch(task.id, { state: 'verified', notes });
            await publishSnapshot().catch(() => { });
            return { id: updated.id, state: updated.state };
        }
        const reason = remark ?? 'no reason given';
        notes.push(`rejected from the router panel at ${stamp}: ${reason}`);
        const updated = await board.patch(task.id, {
            state: 'failed',
            error: `rejected by operator: ${reason}`,
            notes,
        });
        await publishSnapshot().catch(() => { });
        return { id: updated.id, state: updated.state };
    };
    /** Flip one partition's operator switch and persist it on the board. */
    const setPartitionState = async (name, enabled) => {
        const partition = partitions.find(entry => entry.name === name);
        if (partition === undefined) {
            throw new BridgeError(404, 'not-found', `unknown partition "${name}"; configured: ${partitions.map(entry => entry.name).join(', ')}`);
        }
        await board.patchPartition(name, { disabled: !enabled });
        // Re-enabling is also the moment to drain whatever queued up meanwhile.
        if (enabled)
            await pump(name, undefined);
        await publishSnapshot().catch(() => { });
        return { id: name, enabled };
    };
    /**
     * Presence (never a value) of the configured credential references.
     *
     * `ctx.credentials.describe(ref)` answers "is something stored for this
     * reference, where from, and is it writable" without returning the value,
     * which is exactly the badge the panel draws next to a key it does not own.
     */
    const credentialStatus = async () => {
        const service = ctx.get('credentials');
        const refs = config.credentialRefs ?? DEFAULT_CREDENTIAL_REFS;
        const views = [];
        for (const entry of refs) {
            const label = entry.label === undefined ? {} : { label: entry.label };
            if (service === undefined || typeof service.describe !== 'function') {
                views.push({ ref: entry.ref, ...label, configured: false, source: 'unknown' });
                continue;
            }
            try {
                const info = await service.describe(entry.ref);
                views.push({
                    ref: entry.ref,
                    ...label,
                    configured: info?.configured === true,
                    source: credentialSourceOf(info?.source),
                    ...info?.writable === undefined ? {} : { writable: info.writable === true },
                });
            }
            catch (error) {
                // A provider that cannot answer is not the same as a missing key, so the
                // row says `unknown` instead of claiming the key is absent.
                views.push({ ref: entry.ref, ...label, configured: false, source: 'unknown' });
                ctx.logger.warn(`host-router: could not describe credential ${entry.ref}: ${String(error)}`);
            }
        }
        return views;
    };
    /** Shared tool-result body for `route_task`. */
    const routeResult = (task, note) => ({
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
    });
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        async execute(raw, exec) {
            const args = raw;
            if (exec.agent !== undefined)
                lastCaller = exec.agent;
            if (typeof args.text !== 'string' || args.text.trim() === '') {
                throw new Error('route_task requires non-empty text');
            }
            // The dispatcher's own context, not the worker's: a child starts empty, so
            // the only session this call can bloat is the one making the decision.
            const refused = exec.agent === undefined
                ? undefined
                : await attachRefusal(exec.agent.session.id, 'This session');
            if (refused !== undefined) {
                throw new Error(`${refused} Finish the work yourself instead of delegating it.`);
            }
            const decision = await route(args);
            if (!isEnabled(decision.partition.name)) {
                throw new Error(`partition "${decision.partition.name}" is disabled; enable it from the router panel first`);
            }
            // A manager always passes parent_task; that is the signal that this call is
            // level 2 and must start a worker rather than another manager.
            const fromManager = args.parent_task !== undefined;
            const level = decision.partition.managerEnabled && !fromManager ? 'manager' : 'worker';
            const tier = await decideTier(args);
            const task = await enqueue(args, decision, level, exec.agent, tier);
            await pump(decision.partition.name, exec.agent);
            const after = board.get(task.id) ?? task;
            return routeResult(after, after.state === 'queued'
                ? 'Queued: a worker limit is reached or no live parent agent was found. It starts when a slot frees (task_board re-drives it).'
                : 'Dispatched. Its report will arrive as a message; task_progress shows worker detail.');
        },
    }));
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        async execute() {
            const lines = partitions.map((partition) => {
                const load = runningCount(partition.name);
                const queued = board.inPartition(partition.name).filter(task => task.state === 'queued').length;
                const verify = autoVerify && (partition.verify?.length ?? 0) > 0
                    ? `verify: ${partition.verify.join(' | ')}`
                    : 'verify: none (a normal worker end is recorded as `done`)';
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
                ].join('\n');
            });
            return { text: lines.join('\n') };
        },
    }));
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        async execute(raw) {
            const args = raw;
            if (args.partition !== undefined) {
                if (!partitions.some(entry => entry.name === args.partition)) {
                    throw new Error(`unknown partition "${args.partition}"`);
                }
                // A human looking at the board is the most reliable moment to notice work
                // left queued by a restart, so reading also re-drives the queue.
                await pump(args.partition, undefined);
            }
            if (args.task_id !== undefined) {
                const task = board.get(args.task_id);
                if (task === undefined)
                    throw new Error(`unknown task "${args.task_id}"`);
                const children = board.childrenOf(task.id);
                return {
                    text: [
                        JSON.stringify(task, undefined, 2),
                        children.length === 0 ? '(no child tasks)' : `children:\n${summarize(children)}`,
                    ].join('\n'),
                };
            }
            const tasks = args.partition === undefined ? board.list() : board.inPartition(args.partition);
            return { text: summarize(tasks, args.partition === undefined ? {} : { partition: args.partition }) };
        },
    }));
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        async execute(raw) {
            const args = raw;
            const snapshot = await publishSnapshot();
            const tasks = args.partition === undefined
                ? snapshot.tasks
                : snapshot.tasks.filter(task => task.partition === args.partition);
            const scoped = args.task_id === undefined ? tasks : tasks.filter(task => task.id === args.task_id);
            if (args.task_id !== undefined && scoped.length === 0) {
                throw new Error(`unknown task "${args.task_id}"`);
            }
            const lines = scoped.map((task) => {
                const bar = `${String(Math.round(task.progress * 100))}%`;
                const todos = task.todos.total === 0
                    ? 'no todo list'
                    : `${task.todos.ratio} todos${task.todos.current === undefined ? '' : `, now: ${task.todos.current}`}`;
                return `${mark(task.state)} ${task.id} ${task.partition}/${task.level} ${bar} ${todos}`
                    + ` | session ${task.sessionId ?? '-'} | ${task.subject}`
                    + (task.error === undefined ? '' : `\n    error: ${task.error}`);
            });
            return {
                text: [
                    `${String(scoped.length)} task(s), generated ${snapshot.generatedAt}`,
                    JSON.stringify(snapshot.counts),
                    ...lines,
                ].join('\n'),
            };
        },
    }));
    // --- Control ---------------------------------------------------------------
    ctx.effect(() => ctx.tools.register({
        name: 'task_control',
        description: 'Change one task: `cancel` interrupts its worker and marks it cancelled; `priority` '
            + 'reorders the queue; `retry` re-dispatches a failed or reported task to a fresh worker; '
            + '`resume` continues an interrupted or failed row in its own session from its log; '
            + '`verify` runs the acceptance commands against the current tree; `block` parks it on a human '
            + 'decision; `note` records a remark verbatim.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['task_id', 'action'],
            properties: {
                task_id: { type: 'string', description: 'Task id.' },
                action: {
                    type: 'string',
                    enum: ['cancel', 'priority', 'retry', 'resume', 'verify', 'block', 'note'],
                    description: 'What to change.',
                },
                value: {
                    type: 'string',
                    description: 'Priority for `priority`, remark for `note`, decision needed for `block`, reason for `cancel`.',
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        async execute(raw, exec) {
            const args = raw;
            if (exec.agent !== undefined)
                lastCaller = exec.agent;
            const task = board.get(args.task_id);
            if (task === undefined)
                throw new Error(`unknown task "${args.task_id}"`);
            const partition = partitionOf(task);
            switch (args.action) {
                case 'cancel': {
                    const activation = inFlight.get(task.id);
                    const sessionId = activation?.childId ?? task.sessionId;
                    if (sessionId !== undefined)
                        cancelWorker(ctx.get('subagents'), sessionId);
                    if (activation !== undefined)
                        await activation.dispose().catch(() => { });
                    inFlight.delete(task.id);
                    const updated = await board.patch(task.id, {
                        state: 'cancelled',
                        ...args.value === undefined ? {} : { error: `cancelled: ${args.value}` },
                    });
                    await publishSnapshot().catch(() => { });
                    return {
                        text: `${updated.id} cancelled (${sessionId === undefined ? 'no live worker' : `interrupted ${sessionId}`})`,
                    };
                }
                case 'priority': {
                    const value = Number(args.value);
                    if (!Number.isInteger(value))
                        throw new Error('priority requires an integer value');
                    const updated = await board.patch(task.id, { priority: value });
                    await pump(partition.name, exec.agent ?? lastCaller);
                    return { text: `${updated.id} priority -> ${String(value)}` };
                }
                case 'retry': {
                    if (task.state === 'running' || task.state === 'dispatched') {
                        throw new Error(`${task.id} is still in flight; cancel it first`);
                    }
                    const parent = exec.agent ?? liveAgent(task.dispatchFrom) ?? lastCaller;
                    if (parent === undefined)
                        throw new Error('retry needs a live agent to own the new worker');
                    await board.patch(task.id, { state: 'queued' });
                    await pump(partition.name, parent);
                    const after = board.get(task.id);
                    await publishSnapshot().catch(() => { });
                    return { text: `${after.id} state ${after.state}; worker ${after.worker ?? '-'}` };
                }
                case 'resume': {
                    if (task.state === 'running' || task.state === 'dispatched') {
                        throw new Error(`${task.id} is still in flight`);
                    }
                    const sender = exec.agent ?? liveAgent(task.dispatchFrom) ?? lastCaller;
                    if (sender === undefined)
                        throw new Error('resume needs a live agent to own the delivery');
                    const line = await resumeRow({ ...task, resumes: 0 }, sender);
                    await publishSnapshot().catch(() => { });
                    return { text: line };
                }
                case 'verify': {
                    const commands = task.verify ?? partition.verify ?? [];
                    const verdict = await runVerify(commands, partition.dir, verifyTimeout);
                    const updated = await board.patch(task.id, {
                        state: verdict.ok ? 'verified' : 'failed',
                        verify: commands,
                        verifyOutput: tail(verdict.output),
                        ...verdict.ok ? {} : { error: `acceptance failed: ${verdict.failed ?? 'unknown command'}` },
                    });
                    await publishSnapshot().catch(() => { });
                    return { text: `${updated.id} -> ${updated.state}\n${tail(verdict.output)}` };
                }
                case 'block': {
                    const updated = await board.patch(task.id, {
                        state: 'blocked',
                        resumeNote: args.value ?? '(no note)',
                    });
                    await publishSnapshot().catch(() => { });
                    return { text: `${updated.id} blocked: ${updated.resumeNote ?? ''}` };
                }
                case 'note': {
                    if (args.value === undefined)
                        throw new Error('note requires a value');
                    const updated = await board.note(task.id, args.value);
                    return { text: `${updated.id} has ${String(updated.notes?.length ?? 0)} note(s)` };
                }
                default:
                    throw new Error(`unknown action "${args.action}"`);
            }
        },
    }));
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
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        async execute(raw, exec) {
            const args = raw;
            if (exec.agent !== undefined)
                lastCaller = exec.agent;
            const task = board.get(args.task_id);
            if (task === undefined)
                throw new Error(`unknown task "${args.task_id}"`);
            if (task.sessionId === undefined) {
                throw new Error(`${task.id} has no worker session yet; retry it or publish a new task`);
            }
            // This is the "insert into a session that is already running" path, so it is
            // the one place the worker's own history, not the caller's, decides.
            const refused = await attachRefusal(task.sessionId, 'That worker session');
            if (refused !== undefined) {
                throw new Error(`${refused} Publish a new task for this work, or do it yourself.`);
            }
            const sender = exec.agent ?? liveAgent(task.dispatchFrom) ?? lastCaller;
            if (sender === undefined)
                throw new Error('task_resume needs a live agent to own the delivery');
            const messageId = await continueWorker(ctx.get('subagents'), sender, task.sessionId, args.text, exec.signal);
            const updated = await board.patch(task.id, { state: 'running', reportedTo: sender.id });
            await publishSnapshot().catch(() => { });
            return {
                text: `${updated.id} continued (session ${task.sessionId}, message ${messageId}). `
                    + 'The row returns to `reported` from its session log when the worker stops, because a resumed '
                    + 'session has no activation handle in this process.',
            };
        },
    }));
    // Optional in-process handle for a host-side bridge. The JSON snapshot is the
    // guaranteed contract; this only saves a file read when cordis offers `set`.
    const service = {
        snapshot: (_request) => publishSnapshot(),
        task: async (taskId) => (await publishSnapshot()).tasks.find(task => task.id === taskId),
        snapshotPath,
    };
    if (typeof ctx.set === 'function') {
        try {
            ctx.set('hostRouter', service);
            ctx.logger.info('host-router: published ctx.hostRouter { snapshot, task, snapshotPath }');
        }
        catch (error) {
            ctx.logger.warn(`host-router: could not publish ctx.hostRouter: ${String(error)}`);
        }
    }
    // --- HTTP bridge for the Web client ---------------------------------------
    //
    // The panel runs in the browser and cannot reach this process's services, so
    // the same facts are published over the one seam both halves already share:
    // the web server that serves the shell. `ctx.inject` is what makes the mount
    // independent of activation order — the callback runs as soon as `webServer`
    // is available, and its routes are disposed with the plugin.
    const bridgeDeps = {
        logger: ctx.logger,
        partitions: partitions.map(partition => ({
            name: partition.name,
            dir: partition.dir,
            slots: partition.slots,
            managerEnabled: partition.managerEnabled,
        })),
        isEnabled,
        snapshot: () => publishSnapshot(),
        publish: publishDemands,
        anchor: anchorSession,
        verify: decideFromPanel,
        setPartitionState,
        credentials: credentialStatus,
        // Every board mutation rewrites this file, so its mtime is the change signal
        // the SSE route watches. No second bookkeeping to drift.
        changeFile: join(boardDir, 'board.json'),
        tiers: tierFace,
    };
    if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (webCtx) => {
            const webServer = webCtx.webServer;
            if (webServer === undefined || typeof webServer.register !== 'function') {
                ctx.logger.warn('host-router: webServer exposes no register(); the HTTP bridge is not mounted');
                return;
            }
            for (const route of createRoutes(bridgeDeps)) {
                webCtx.effect(() => webServer.register(route), `host-router: ${route.path}`);
            }
            ctx.logger.info(`host-router: HTTP bridge mounted at ${BRIDGE_BASE} (board/publish/anchor/verify/partition/tiers/events)`);
        });
    }
    else {
        ctx.logger.info('host-router: this context has no ctx.inject; the HTTP bridge is not mounted (tools only)');
    }
    // --- Resume after a restart ------------------------------------------------
    //
    // A row the previous process left in flight is `interrupted` (board.ts
    // reconcile, or `finish` while stopping). Its session log is intact, so the
    // same session is restored with `sendMessage` (cold resume from the durable
    // log) and told to continue from its own todo list. Managers go first so a
    // resumed worker's closing report has a live parent to land in.
    /** Most resumes one row gets before it is left for a human. */
    const MAX_RESUMES = 3;
    const RESUME_TEXT = [
        '【系统通知】DSH 进程刚刚重启，你上一轮的执行被中断了。你的会话历史和 todo 列表都还在。',
        '请先看你的 todo 列表，从中断的那一步继续，已经完成的步骤不要重做。',
        '如果你是 manager：你派出的 worker 也会被逐个恢复，它们会照常把结果报给你；',
        '用 wait_agent 等待即可，不要把同样的工作重新派一遍。',
    ].join('\n');
    /** Rows resumed in this process that have no activation handle to settle them. */
    const resumedRows = new Set();
    let settleTimer;
    /** Settle resumed rows from their logs (the snapshot does it) until none is left. */
    const watchResumed = () => {
        if (settleTimer !== undefined)
            return;
        settleTimer = setInterval(() => {
            void (async () => {
                await publishSnapshot().catch(() => { });
                for (const id of [...resumedRows]) {
                    const row = board.get(id);
                    if (row === undefined || (row.state !== 'running' && row.state !== 'dispatched'))
                        resumedRows.delete(id);
                }
                if (resumedRows.size === 0 && settleTimer !== undefined) {
                    clearInterval(settleTimer);
                    settleTimer = undefined;
                }
            })();
        }, 15_000);
        settleTimer.unref?.();
        ctx.effect(() => () => {
            if (settleTimer !== undefined)
                clearInterval(settleTimer);
            settleTimer = undefined;
        }, 'host-router: resume settle timer');
    };
    /**
     * Resume one interrupted row in its own session.
     * @returns what happened, for the boot log.
     */
    const resumeRow = async (task, sender) => {
        if (task.sessionId === undefined) {
            await board.patch(task.id, { state: 'queued' });
            return `${task.id}: no session, re-queued`;
        }
        // A child that finished just before the stop needs no second turn.
        const facts = foldWorkerLog(await readLog(task.sessionId));
        if (facts.endedWith === 'completed' && facts.lastAssistant !== undefined) {
            await board.patch(task.id, { state: 'done', result: facts.lastAssistant });
            return `${task.id}: already completed in its log, closed`;
        }
        const resumes = (task.resumes ?? 0) + 1;
        if (resumes > MAX_RESUMES) {
            await board.patch(task.id, { state: 'failed', error: `interrupted ${String(MAX_RESUMES)} times; resume it by hand (task_control resume) or retry` });
            return `${task.id}: resume limit reached`;
        }
        await continueWorker(ctx.get('subagents'), sender, task.sessionId, RESUME_TEXT, AbortSignal.timeout(60_000));
        await board.patch(task.id, { state: 'running', resumes, runToken, reportedTo: sender.id });
        resumedRows.add(task.id);
        watchResumed();
        return `${task.id}: resumed session ${task.sessionId} (resume ${String(resumes)})`;
    };
    /** Resume every interrupted row, managers first, then drive the queues. */
    const resumeInterrupted = async () => {
        const waiting = board.list()
            .filter(task => task.state === 'interrupted')
            .sort((left, right) => (left.level === right.level ? 0 : left.level === 'manager' ? -1 : 1)
            || Date.parse(left.createdAt) - Date.parse(right.createdAt));
        const hasQueued = board.list().some(task => task.state === 'queued');
        if (waiting.length === 0 && !hasQueued)
            return;
        const anchor = await ensureAnchor();
        if (anchor === undefined) {
            ctx.logger.warn(`host-router: ${String(waiting.length)} interrupted task(s) wait for a live anchor; nothing resumed`);
            return;
        }
        for (const task of waiting) {
            try {
                ctx.logger.info(`host-router: ${await resumeRow(task, anchor)}`);
            }
            catch (error) {
                ctx.logger.warn(`host-router: resuming ${task.id} failed: ${String(error)}`);
                await board.patch(task.id, { state: 'failed', error: `resume after restart failed: ${String(error)}` }).catch(() => { });
            }
        }
        for (const partition of partitions)
            await pump(partition.name, anchor).catch(() => { });
        await publishSnapshot().catch(() => { });
    };
    // Off the boot path: agents, sessions and the subagent manager must be up first.
    const resumeTimer = setTimeout(() => {
        void resumeInterrupted().catch((error) => {
            ctx.logger.warn(`host-router: resume after restart failed: ${String(error)}`);
        });
    }, config.resumeDelayMs ?? 8_000);
    resumeTimer.unref?.();
    ctx.effect(() => () => { clearTimeout(resumeTimer); }, 'host-router: resume timer');
    ctx.logger.info(`host-router: ${String(partitions.length)} partition(s), board ${join(boardDir, 'board.json')}, `
        + `${String(board.list().filter(task => task.state === 'queued').length)} queued task(s)`);
}
/** Exported so a deployment or test can validate config without booting the plugin. */
export { normalisePartitions, resolveRoute };
//# sourceMappingURL=index.js.map