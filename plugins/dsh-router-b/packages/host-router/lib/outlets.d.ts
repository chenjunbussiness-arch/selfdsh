/**
 * Outlets: the things an agent does that leave the sandbox or cannot be undone.
 *
 * Every outlet call is classified, checked against the partition's policy, and
 * written to an audit log. A call the policy says needs a human does not run:
 * it becomes an approval the panel shows as a card, and only a human's 同意
 * runs it, once. Nothing here offers "always allow": an approval covers the one
 * action it describes.
 *
 * Kinds:
 *   git      push a work branch, open or update a pull request    (reversible)
 *   merge    merge a pull request                                  (needs a human, always)
 *   ops      a shell command on the server, by risk level          (read / change / danger)
 *   browser  headless screenshot or page text of a URL             (read-only)
 *
 * Files: `<boardDir>/approvals.json` (the queue) and `<boardDir>/audit/<yyyy-mm>.jsonl`.
 *
 * @module host-router/outlets
 */
/** An outlet kind. */
export type OutletKind = 'git' | 'merge' | 'ops' | 'browser';
/** What a partition allows for one kind. */
export type OutletMode = 'off' | 'confirm' | 'allow';
/** Risk of one shell command. */
export type OpsLevel = 'read' | 'change' | 'danger';
/** Per-partition outlet policy (`outlets` in a partition's configuration). */
export interface OutletPolicy {
    readonly git?: OutletMode;
    readonly ops?: OutletMode;
    readonly browser?: OutletMode;
    /** Extra commands to treat as dangerous here, as regular expressions. */
    readonly danger?: readonly string[];
    /** Hosts the browser may open (exact or `*.example.com`); empty or absent: any. */
    readonly browserAllow?: readonly string[];
}
/** Defaults: git and browser run, ops run but danger asks, merge always asks. */
export declare const DEFAULT_POLICY: Required<Pick<OutletPolicy, 'git' | 'ops' | 'browser'>>;
/** One approval request. */
export interface Approval {
    readonly id: string;
    readonly kind: OutletKind;
    readonly partition: string;
    readonly taskId?: string;
    /** Session that asked, told the outcome. */
    readonly sessionId?: string;
    /** One-line action, e.g. `merge PR #12 into main`. */
    readonly action: string;
    /** What it acts on: a PR URL, a command, a host. */
    readonly target: string;
    /** Why the agent wants it. */
    readonly reason: string;
    /** Whether it can be undone afterwards. */
    readonly reversible: boolean;
    /** Arguments the executor needs; never secrets. */
    readonly params: Readonly<Record<string, unknown>>;
    readonly state: 'pending' | 'approved' | 'rejected' | 'done' | 'failed' | 'expired';
    readonly createdAt: string;
    readonly decidedAt?: string;
    readonly note?: string;
    /** Executor output, trimmed. */
    readonly result?: string;
}
/** One audit line. */
export interface AuditEntry {
    readonly at: string;
    readonly kind: OutletKind;
    readonly partition: string;
    readonly taskId?: string;
    readonly action: string;
    readonly target: string;
    readonly outcome: 'ran' | 'asked' | 'approved' | 'rejected' | 'refused' | 'failed' | 'expired';
    readonly by: 'agent' | 'human' | 'router';
    readonly detail?: string;
}
/**
 * Risk level of a shell command.
 *
 * `read` only when every segment of every pipeline is a known read-only
 * command; anything that matches a danger pattern (built-in or the partition's
 * own) is `danger`; everything else is `change`.
 */
export declare function classifyCommand(command: string, extraDanger?: readonly string[]): OpsLevel;
/** Whether a host is allowed by a browser allowlist. */
export declare function hostAllowed(host: string, allow: readonly string[] | undefined): boolean;
/** Pending approvals older than this expire (the agent has long moved on). */
export declare const APPROVAL_TTL_MS: number;
/** The approval queue plus the audit log, persisted under the board directory. */
export declare class OutletStore {
    private readonly dir;
    private items;
    private chain;
    private seq;
    private constructor();
    /** Open (or create) the store in `dir`. */
    static open(dir: string): Promise<OutletStore>;
    /** Every approval, newest first. */
    list(): readonly Approval[];
    pending(): readonly Approval[];
    get(id: string): Approval | undefined;
    /** Queue a new approval and audit it as `asked`. */
    request(input: Omit<Approval, 'id' | 'state' | 'createdAt'>, now?: Date): Promise<Approval>;
    /** Change one approval. */
    patch(id: string, change: Partial<Approval>): Promise<Approval>;
    /** Expire pending approvals past the TTL; returns the ones it expired. */
    expire(now?: number): Promise<readonly Approval[]>;
    /** Append one audit line to this month's file. */
    audit(entry: Omit<AuditEntry, 'at'>, now?: Date): Promise<void>;
    /** The newest audit lines, newest first. */
    recentAudit(limit?: number): Promise<readonly AuditEntry[]>;
    private persist;
}
/** Result of one process run. */
export interface RunResult {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}
/** Run a program without a shell. */
export declare function run(file: string, args: readonly string[], cwd: string, timeoutMs?: number): Promise<RunResult>;
/** Run one command line through the platform shell (ops). */
export declare function runShell(command: string, cwd: string, timeoutMs?: number): Promise<RunResult>;
/** Local git facts of one checkout. */
export interface GitFacts {
    readonly branch: string;
    readonly dirty: readonly string[];
    readonly ahead?: number;
}
/** Read the current branch and uncommitted paths. */
export declare function gitFacts(cwd: string): Promise<GitFacts>;
/** A branch name the router may push: no default branch, nothing odd. */
export declare function pushableBranch(branch: string, defaultBranch: string): string | undefined;
/** Branch name a request's workers share: `dsh/<root id>`. */
export declare const requestBranch: (rootId: string) => string;
