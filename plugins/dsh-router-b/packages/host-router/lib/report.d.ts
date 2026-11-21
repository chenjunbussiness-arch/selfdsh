/**
 * The report contract: what a worker actually did, in a shape a decision can use.
 *
 * A worker's closing message used to be prose. Prose is unreadable to the level-2
 * decision, which has to answer one question — "does this session already hold
 * the work I am about to hand out?" — and answering it from free text means
 * guessing. So every worker is asked to end with a fixed block:
 *
 * ```
 * --- report ---
 * summary: what you actually did, in one sentence
 * touched: comma-separated paths you changed, or "none"
 * left: what is still open, or "none"
 * ```
 *
 * Three keys, one line each. The block is appended by the model, then parsed
 * here into `RouterTask.summary` / `.touched` / `.left`, which is what
 * `managerPrompt()` and the board both read.
 *
 * Parsing is deliberately lenient about *formatting* and strict about
 * *presence*: extra keys are ignored, case and spacing do not matter, but a
 * message with no marker yields undefined rather than a guess. A guessed report
 * would be worse than none — the decision would trust a summary the worker never
 * wrote.
 *
 * @module host-router/report
 */
/** Marker line that opens the block. Matched on its own line, trimmed. */
export declare const REPORT_MARKER = "--- report ---";
/** What one worker said about its own work. */
export interface WorkerReport {
    /** One sentence: what the worker says it actually did. */
    readonly summary?: string;
    /** Paths the worker says it changed or created. Empty when it changed nothing. */
    readonly touched: readonly string[];
    /** What the worker says is still open; absent when it said none. */
    readonly left?: string;
}
/**
 * Read the report block out of one worker message.
 *
 * Uses the **last** marker: a worker that quotes the contract in its reasoning
 * and then writes the real block at the end must be read as the second one.
 * @param text - the worker's closing text, exactly as it produced it.
 * @returns the parsed report, or undefined when the message carries no block.
 */
export declare function parseWorkerReport(text: string): WorkerReport | undefined;
/** The instruction a worker receives, kept next to the parser it feeds. */
export declare const REPORT_INSTRUCTION: readonly string[];
