/**
 * The dispatch side: one worker per task, plus the acceptance check.
 *
 * The load-bearing decision is that this module uses the subagent *service*,
 * not the `subagent` tool:
 *
 * - `ctx.subagents.startActivation({ cwd })` takes an absolute directory, and
 *   `SubagentManager.resolveDirectory` uses it verbatim. The local materializer
 *   then calls `workingDirectory.set(child, cwd)` before the child's first turn,
 *   so the child's working-directory service value is the partition root even
 *   though `session.header.cwd` still records the parent's creation directory.
 *   (Verified in the running build: `dsh-subagent/lib/index.js` around the
 *   `resolveDirectory` and `materializeTracked` regions.) Sandbox policy reads
 *   the working-directory value first, so writes land inside the partition.
 * - The tool's own `cwd` parameter is not a stable API: it exists in the
 *   running 0.2.2-rc.3 and is gone from the 0.2.2-rc.5 `tool-subagent` source,
 *   while the *service* keeps `cwd` in both. Calling the service is what makes
 *   this package survive the next rc bump.
 * - The returned `result` promise settles after the child's teardown, which is
 *   the only supported way for a host plugin to learn how a child ended without
 *   parsing a session log.
 *
 * @module host-router/dispatch
 */
import type { ContentBlock, LiveAgent, SubagentActivation, SubagentsService } from './types.ts';
/** Everything the router decides about one child before starting it. */
export interface StartWorkerSpec {
    /** Absolute directory the child is rooted in. */
    readonly cwd: string;
    /** Text handed to the child, before the brief is added. */
    readonly prompt: string;
    /** Subagent provider name. */
    readonly provider: string;
    /** The live agent that owns the child. */
    readonly parent: LiveAgent;
    /** Cancellation from the tool call that triggered this start. */
    readonly signal: AbortSignal;
    /** Short label retained in the subagent catalog. */
    readonly label: string;
    /** Optional preset id. */
    readonly preset?: string;
    /** Optional recursion cap handed to the seam. */
    readonly maxDepth?: number;
    /**
     * Who receives the child's closing report. Default `parent`. `caller` is
     * used when the parent is the router's own anchor: nobody reads that session,
     * and a delivered report would wake it to redo or cancel the work itself.
     */
    readonly delivery?: 'parent' | 'caller';
    /** Model route for the child; omitted means it inherits the parent's. */
    readonly agentOptions?: {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    };
}
/** Join text blocks into the readable report a worker produced. */
export declare function textOf(blocks: readonly ContentBlock[]): string;
/**
 * Start one continuable child rooted in a partition.
 *
 * `delivery: 'parent'` is deliberate: the runtime then hands the child's closing
 * report to its creator as a user-role message, which is how the human-facing
 * session learns that a worker finished without polling anything. The router
 * reads the same result through {@link SubagentActivation.result} to close its
 * board row, so the two views cannot disagree about the stop reason.
 * @param subagents - the subagent seam.
 * @param spec - directory, prompt, parent, and routing choices.
 * @returns the activation handle for the started child.
 */
export declare function startWorker(subagents: SubagentsService, spec: StartWorkerSpec): Promise<SubagentActivation>;
/**
 * Continue an existing worker session.
 *
 * This is the "续作" path: `sendMessage` restores a settled child from its
 * durable log when needed (cold resume) and delivers the text as a user-role
 * message, so a worker keeps its own history instead of starting over. It
 * requires the sender to be a live member of the same subagent tree, which is
 * why the router re-resolves the original dispatcher before calling.
 * @param subagents - the subagent seam.
 * @param sender - live agent that owns the child.
 * @param childId - durable child session id.
 * @param text - the follow-up instruction.
 * @param signal - caller cancellation.
 * @returns the accepted inbox message id.
 */
export declare function continueWorker(subagents: SubagentsService, sender: LiveAgent, childId: string, text: string, signal: AbortSignal): Promise<string>;
/**
 * Stop one child's current turn.
 *
 * `{ kind: 'user' }` is used on purpose: it is the trusted host operation the
 * seam documents for a human-initiated stop, and unlike the `ancestor` form it
 * does not require the original creator to be live — which matters precisely
 * when a cancel arrives after a restart.
 * @param subagents - the subagent seam.
 * @param childId - durable child session id.
 */
export declare function cancelWorker(subagents: SubagentsService, childId: string): void;
/** Outcome of running a partition's acceptance commands. */
export interface VerifyOutcome {
    /** True only when every command exited 0. */
    readonly ok: boolean;
    /** Combined output of every command that ran, in order. */
    readonly output: string;
    /** The first command that failed, when one did. */
    readonly failed?: string;
}
/**
 * Decide whether a reported task is actually done.
 *
 * With no configured commands the answer is "unverified": the router records the
 * claim and says so, rather than promoting a worker's own word to done. With
 * commands, every one must exit 0; the first failure names itself so the human
 * reads one line instead of a wall of output.
 * @param commands - acceptance commands from the partition or the task.
 * @param cwd - directory to run them in.
 * @param timeoutMs - per-command timeout.
 * @returns the outcome, with the combined output bounded by {@link tail}.
 */
export declare function runVerify(commands: readonly string[], cwd: string, timeoutMs: number): Promise<VerifyOutcome>;
