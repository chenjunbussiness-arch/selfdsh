/**
 * 【作战室状态】: what is still open, re-posted to the 作战室 after its history is compacted.
 *
 * DSH condenses an old span of the conversation into one summary once the context grows
 * past its threshold (`@deepseek-ai/dsh-compaction-basic`, `thresholdRatio`). The summary
 * is written by a model and can drop a task that is still running or a question that is
 * still waiting on the human. The router knows both for certain: its board, and the
 * 【进度提醒】 lines that asked the human something and have not been closed since. After
 * every compaction of the anchor session it injects one short message listing them, so the
 * 作战室 carries on from facts rather than from the summary's recollection.
 */
import { type RouterTask } from './board.ts';
import { type NoticeMessage } from './notices.ts';
/** First line of the state message. */
export declare const STATE_HEAD = "\u3010\u4F5C\u6218\u5BA4\u72B6\u6001\u3011";
/** How long an unanswered question stays on the list. */
export declare const ASK_TTL_MS: number;
/** Most rows and questions each section lists; the rest are counted. */
export declare const STATE_MAX_LINES = 15;
/**
 * Questions put to the human through 【进度提醒】 that nothing has closed yet: the latest
 * ask line per subject, dropped when a later line says that subject finished or was
 * cancelled, or after {@link ASK_TTL_MS}. Kept in memory: a restart starts it empty.
 */
export declare class OpenAsks {
    private readonly bySubject;
    /** Feed every notice line, in the order they were posted. */
    note(line: string, now?: number): void;
    /** The open questions, oldest first. */
    list(now?: number): string[];
}
/** Whether an inbox message is a 【作战室状态】 the router posted earlier (and can replace). */
export declare function isStateMessage(message: NoticeMessage): boolean;
/**
 * The text of one 【作战室状态】 message, or undefined when nothing is open (then nothing
 * is posted: an empty list would only cost tokens).
 * @param tasks - the router board.
 * @param asks - open questions from {@link OpenAsks.list}.
 */
export declare function compactStateText(tasks: readonly RouterTask[], asks: readonly string[]): string | undefined;
/** Default context size (tokens) past which the router compacts the 作战室 itself. */
export declare const ANCHOR_COMPACT_TOKENS = 300000;
/** The part of DSH's compaction service (`ctx.compaction`) the router calls. */
export interface CompactionEngineLike {
    compactNow(agent: never, signal: AbortSignal): Promise<{
        readonly shadowedTokenCount?: number;
    } | null>;
}
/** What {@link AnchorCompactor} needs from the router. */
export interface AnchorCompactorDeps {
    /** Tokens past which to compact; 0 turns it off. */
    readonly threshold: number;
    /** The live 作战室 Agent, if any. */
    agent(): {
        readonly status?: string;
    } | undefined;
    /** That Agent's compaction service (it lives inside the agent preset), if any. */
    engine(agent: object): CompactionEngineLike | undefined;
    readonly log: {
        info(message: string): void;
        warn(message: string): void;
    };
    readonly now?: () => number;
    /** Wait after a turn ends, and between checks for idle. Default 1500 ms. */
    readonly retryMs?: number;
}
/**
 * Keeps the 作战室 under {@link AnchorCompactorDeps.threshold} tokens.
 *
 * Fed the context size of each of its replies ({@link sample}) and told when a turn ends
 * ({@link turnEnded}); once the last size is past the threshold it waits for the Agent to
 * be idle and calls `compactNow`, the same call `/compact` makes. A turn that starts in the
 * meantime only delays it (DSH refuses a compaction while the Agent works: `busy`).
 */
export declare class AnchorCompactor {
    private readonly deps;
    private tokens;
    private running;
    private timer;
    private pausedUntil;
    private warnedNoEngine;
    private readonly abort;
    constructor(deps: AnchorCompactorDeps);
    /** The context size the 作战室's latest model call reported. */
    sample(tokens: number | undefined): void;
    /** History was just compacted (by this or by anything else): the old size no longer holds. */
    compacted(): void;
    /** A turn of the 作战室 ended: compact soon if it has grown past the threshold. */
    turnEnded(): void;
    /** Stop any pending check and cancel a compaction in flight. */
    dispose(): void;
    private due;
    private schedule;
    private run;
}
