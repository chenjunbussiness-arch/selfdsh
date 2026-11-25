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
import type { OutletPolicy } from './outlets.ts';
import { type ScmConfig } from './scm.ts';
/** Reachability a partition declares, so its workers stop guessing. */
export type PartitionNetwork = 'intranet' | 'internet' | 'offline';
/** Git instructions attached to a worker's brief. */
export interface PartitionGit {
    /** Branch workers should be on. Created from HEAD when absent. */
    readonly branch?: string;
    /** Extra git rule for this partition, appended verbatim. */
    readonly rule?: string;
    /**
     * Code host of this checkout (GitHub or Gitea). With it, workers publish their
     * branch and open or update a pull request through `git_publish`, read checks
     * through `pr_status`, and ask for a merge through `pr_merge` (a human approves).
     */
    readonly scm?: ScmConfig;
}
/** One declarative file partition. */
export interface PartitionConfig {
    /** Stable identifier used by tools, the board, and the manager key. */
    readonly name: string;
    /** Absolute directory containing the partition's files; also the worker cwd. */
    readonly root: string;
    /** Globs (POSIX, relative to `root`) selecting member files. Default `**`. */
    readonly include?: readonly string[];
    /** Globs removed from the member set after `include`. */
    readonly exclude?: readonly string[];
    /**
     * One or two sentences on what this partition contains. Shown to the LLM
     * classifier that routes free text the keyword score cannot settle.
     */
    readonly description?: string;
    /** Words that route free-text tasks here. Case-insensitive. */
    readonly keywords?: readonly string[];
    /** Concurrent worker sessions allowed in this partition. Default 2; `0` means no partition cap. */
    readonly workers?: number;
    /** Agent preset mounted for this partition's manager and workers. */
    readonly preset?: string;
    /** Acceptance commands, run in `root` after a worker reports done. */
    readonly verify?: readonly string[];
    /** Standing instructions prepended to every worker prompt here. */
    readonly brief?: string;
    /**
     * How this partition reaches the network, declared rather than guessed.
     *
     * The same machine cannot serve every partition: one root needs the intranet
     * VPN to reach its database, another needs public internet for a search, a
     * third must build offline. A worker that guesses gets a timeout it cannot
     * explain, so the answer travels in its brief instead.
     */
    readonly network?: PartitionNetwork;
    /**
     * Git instructions for workers in this partition.
     *
     * Instructions only: the router does not run git. Every checkout it shares
     * with a human and with other agents, so a `checkout` / `reset` / `clean`
     * would move work that is not the worker's to move.
     */
    readonly git?: PartitionGit;
    /**
     * What agents in this partition may do outside the sandbox: push and open
     * pull requests (`git`), run server commands (`ops`), open pages headless
     * (`browser`). `off` refuses, `confirm` asks a human every time, `allow` runs
     * (dangerous commands and merges still ask). See outlets.ts.
     */
    readonly outlets?: OutletPolicy;
    /**
     * Use one long-lived manager child for this partition: tasks are handed to it
     * and it decomposes them into worker calls. Default follows the router-level
     * `manager` flag.
     */
    readonly manager?: boolean;
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
    readonly id: string;
    /** Environment-variable name the harness resolves, e.g. `DEEPSEEK_API_KEY`. */
    readonly ref: string;
    /** Display name the panel shows next to the badge, e.g. `DeepSeek`. */
    readonly label?: string;
}
/**
 * Defaults for {@link CredentialRefConfig}.
 *
 * Both names are the ones the running build actually resolves: `DEEPSEEK_API_KEY`
 * (`dsh-llm-deepseek-api-key/src/config.ts:25`) and `EXA_API_KEY`
 * (`dsh-web-search-exa/lib/index.js:146`). Listing another provider is a config
 * change, not a code change.
 */
export declare const DEFAULT_CREDENTIAL_REFS: readonly CredentialRefConfig[];
/**
 * Default prompt-side context ceiling, in tokens.
 *
 * 256k, not the model's window: quality, not capacity, is the binding limit.
 * A session that has already spent 256k prompt tokens on its own history is
 * re-reading more than it is thinking, which is the observed way a worker
 * "forgets what it was doing" while still having room left in the window.
 */
export declare const DEFAULT_CONTEXT_LIMIT = 262144;
/** Router configuration; `partitions` is the only required member. */
export interface RouterConfig {
    readonly partitions: readonly PartitionConfig[];
    /** Directory for `board.json` and worker output logs. Default `<dsh home>/router`. */
    readonly boardDir?: string;
    /** Partition used when free text matches nothing. Omission makes that an error. */
    readonly defaultPartition?: string;
    /** Process-wide live-worker cap across all partitions. Default 8; `0` means no router cap. */
    readonly maxWorkers?: number;
    /** Default for `PartitionConfig.manager`. Default true. */
    readonly manager?: boolean;
    /** Retries allowed after an error stop. Default 1. */
    readonly maxRetries?: number;
    /** Per-command acceptance timeout. Default 600000 ms. */
    readonly verifyTimeoutMs?: number;
    /** Run declared acceptance commands at all. Default true. */
    readonly autoVerify?: boolean;
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
    readonly contextLimitTokens?: number;
    /**
     * Agent preset used for the router's anchor Agent and for any partition that
     * declares no `preset`. Default `standard`; `''` mounts no preset at all
     * (children then inherit their parent's composition).
     */
    readonly defaultPreset?: string;
    /** Subagent provider name. Default `spawn` (the continuable in-process backend). */
    readonly provider?: string;
    /** Delegation-depth cap handed to the seam, so workers cannot recurse forever. Default 2. */
    readonly maxDepth?: number;
    /**
     * Smallest unique keyword score that routes free text without asking the LLM
     * classifier. Default {@link DEFAULT_AUTO_ROUTE_MIN_SCORE}.
     */
    readonly autoRouteMinScore?: number;
    /** LLM classifier deadline in milliseconds. Default 20000. */
    readonly classifierTimeoutMs?: number;
    /** Delay after boot before interrupted rows are resumed from their logs. Default 8000 ms. */
    readonly resumeDelayMs?: number;
    /** Credential references whose presence the board reports. Default {@link DEFAULT_CREDENTIAL_REFS}. */
    readonly credentialRefs?: readonly CredentialRefConfig[];
    /**
     * Post a short 【进度提醒】 into the 作战室 when a task is suspended or
     * continued, when a prerequisite fails, and when a held-back stage starts.
     * Default true.
     */
    readonly progressNotices?: boolean;
    /** Notices arriving within this window are posted as one message. Default 3000 ms. */
    readonly progressNoticeDelayMs?: number;
    /**
     * Least time between two notices that each start a turn of the 作战室. A notice still
     * waiting in its queue is replaced instead (one queued notice at most). Default 60000 ms.
     */
    readonly progressNoticeMinGapMs?: number;
    /** Most lines in one notice; older ones are folded into a count. Default 12. */
    readonly progressNoticeMaxLines?: number;
    /**
     * Headless screenshot command used by `browser_capture`:
     * `<command> <url> <out.png> [--full] [--wait ms]`. Default `/srv/workspace/bin/screenshot`.
     */
    readonly screenshotCommand?: string;
    /**
     * Server scripts named in the worker brief: `build` builds host plugin code
     * without touching the running copy, `restart` restarts DSH safely (the
     * human runs it). Nothing is said about either when it is not set.
     */
    readonly hostScripts?: HostScripts;
    /**
     * 快任务: small jobs outside every workspace (machine settings, a git command,
     * installing a tool). On by default; `false` turns it off.
     */
    readonly quick?: QuickConfig | false;
}
/** Name the built-in 快任务 partition is routed by. */
export declare const QUICK_PARTITION = "quick";
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
    readonly root?: string;
    /** Concurrent quick workers. Default 2; `0` means no cap. */
    readonly workers?: number;
    /** One line the classifier and the panel show. */
    readonly description?: string;
    /** Outlet policy, as for any partition (dangerous commands still ask). */
    readonly outlets?: OutletPolicy;
}
/** Default one-line description of the 快任务 partition. */
export declare const QUICK_DESCRIPTION = "\u5FEB\u4EFB\u52A1\uFF1A\u4E0D\u5C5E\u4E8E\u4EFB\u4F55\u5DE5\u4F5C\u533A\u7684\u5C0F\u6D3B\uFF0C\u4F8B\u5982\u6539\u7535\u8111\u914D\u7F6E\u3001\u8DD1 git \u547D\u4EE4\u3001\u88C5\u5DE5\u5177\u3001\u67E5\u7AEF\u53E3\u6216\u78C1\u76D8";
/**
 * Build the 快任务 partition, or undefined when it is off or a declared
 * partition already uses its name (the declared one wins).
 * @param raw - `RouterConfig.quick`.
 * @param declared - the normalised declared partitions.
 * @param home - default root.
 */
export declare function quickPartition(raw: QuickConfig | false | undefined, declared: readonly Partition[], home: string): Partition | undefined;
/** Why a task landed where it did; recorded so a human can audit routing. */
export type RouteReason = 'explicit' | 'files' | 'auto' | 'llm' | 'default' | 'manager';
/** One normalised partition. */
export interface Partition extends PartitionConfig {
    /** `resolve()`d root, so two spellings of one directory cannot split a queue. */
    readonly dir: string;
    /** Effective per-partition concurrency; `0` means unlimited. */
    readonly slots: number;
    /** Effective manager flag. */
    readonly managerEnabled: boolean;
    /** The built-in 快任务 partition (see {@link QuickConfig}). */
    readonly quick?: boolean;
}
/** Raised for configuration a deployment must fix, not for a task-level mistake. */
export declare class PartitionConfigError extends Error {
    constructor(message: string);
}
/** Raised when a task cannot be attributed to exactly one partition. */
export declare class RouteError extends Error {
    readonly candidates: readonly string[];
    constructor(message: string, candidates?: readonly string[]);
}
/** Convert Windows separators to POSIX so a glob means one thing on every host. */
export declare function toPosix(path: string): string;
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
export declare function globToRegExp(pattern: string): RegExp;
/** The relative POSIX path of `candidate` under `dir`, or undefined when outside. */
export declare function relativeUnder(dir: string, candidate: string): string | undefined;
/** Whether one absolute file path is a member of the partition. */
export declare function containsFile(partition: Partition, file: string): boolean;
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
export declare function normalisePartitions(partitions: readonly PartitionConfig[], defaults: {
    readonly workers: number;
    readonly manager: boolean;
}): readonly Partition[];
/** Deepest partition whose membership contains `file`; nesting resolves to the tighter root. */
export declare function partitionOfFile(partitions: readonly Partition[], file: string): Partition | undefined;
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
export declare function scoreText(partition: Partition, text: string, extraKeywords?: readonly string[]): number;
/** Outcome of resolving a task to a partition. */
export interface RouteDecision {
    readonly partition: Partition;
    readonly reason: RouteReason;
    /** Ordered evidence, stored on the board so a human can audit the decision. */
    readonly because: readonly string[];
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
export declare function resolveRoute(partitions: readonly Partition[], input: {
    readonly text?: string;
    readonly partition?: string;
    readonly files?: readonly string[];
}, fallback?: string, extraKeywords?: (partition: Partition) => readonly string[]): RouteDecision;
/** Default unique keyword score that routes without the LLM: one name hit or two keyword hits. */
export declare const DEFAULT_AUTO_ROUTE_MIN_SCORE = 4;
/** Smallest classifier confidence the router accepts. */
export declare const CLASSIFIER_MIN_CONFIDENCE = 0.5;
/**
 * Top-level directory names that are specific enough to act as keywords.
 * @param dirs - one partition's top-level directory names.
 * @returns lower-cased names, generic and dot/underscore-prefixed ones removed.
 */
export declare function directoryKeywords(dirs: readonly string[]): readonly string[];
/** What the LLM classifier answered, already validated. */
export interface ClassifierVerdict {
    /** A configured partition name, or `none`. */
    readonly partition: string;
    readonly confidence: number;
    readonly reason: string;
}
/** One classification request: the text plus the facts the prompt shows. */
export interface ClassifierRequest {
    readonly text: string;
    readonly system: string;
    readonly prompt: string;
}
/** Injected LLM call; resolves to the model's raw text, rejects on transport failure. */
export type Classifier = (request: ClassifierRequest) => Promise<string>;
/**
 * Build the classifier prompt.
 * @param partitions - normalised partitions.
 * @param text - the demand text.
 * @param topDirs - partition name -> top-level directory names.
 * @returns system and user prompt text.
 */
export declare function buildClassifierPrompt(partitions: readonly Partition[], text: string, topDirs?: Readonly<Record<string, readonly string[]>>): ClassifierRequest;
/**
 * Parse and validate the classifier's raw answer.
 * @param raw - model text; may wrap the JSON in prose or a code fence.
 * @param partitions - legal partition names.
 * @returns the verdict.
 * @throws {Error} naming exactly what was wrong with the answer.
 */
export declare function parseClassifierOutput(raw: string, partitions: readonly Partition[]): ClassifierVerdict;
/** Options for {@link resolveRouteSmart}. */
export interface SmartRouteOptions {
    /** Configured default partition, if any. */
    readonly fallback?: string;
    /** LLM call; absent means "LLM unavailable". */
    readonly classifier?: Classifier;
    /** Partition name -> top-level directory names, read once at activation. */
    readonly topDirs?: Readonly<Record<string, readonly string[]>>;
    /** Unique keyword score needed to skip the classifier. */
    readonly minScore?: number;
    /** Classifier deadline in milliseconds. Default 20000. */
    readonly timeoutMs?: number;
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
export declare function resolveRouteSmart(partitions: readonly Partition[], input: {
    readonly text?: string;
    readonly partition?: string;
    readonly files?: readonly string[];
}, options?: SmartRouteOptions): Promise<RouteDecision>;
/** Server scripts a worker may be told about. Each is named in the brief only when configured. */
export interface HostScripts {
    /** Builds host plugin code somewhere safe (for example into `lib.next/`) without touching the running copy. */
    readonly build?: string;
    /** Restarts DSH safely; run by the human, so the brief only names it. */
    readonly restart?: string;
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
export declare function partitionBrief(partition: Partition, options: {
    readonly verify: boolean;
    readonly taskId?: string;
    readonly hostScripts?: HostScripts;
}): string;
