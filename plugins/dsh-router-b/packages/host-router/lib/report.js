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
export const REPORT_MARKER = '--- report ---';
/** A path line is a list, not one string: commas and semicolons both appear in practice. */
function splitPaths(value) {
    return value
        .split(/[,;]/)
        .map(entry => entry.trim())
        .filter(entry => entry !== '' && !/^none$/i.test(entry));
}
/**
 * Read the report block out of one worker message.
 *
 * Uses the **last** marker: a worker that quotes the contract in its reasoning
 * and then writes the real block at the end must be read as the second one.
 * @param text - the worker's closing text, exactly as it produced it.
 * @returns the parsed report, or undefined when the message carries no block.
 */
export function parseWorkerReport(text) {
    const lines = text.split(/\r?\n/);
    let start = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
        if (lines[index].trim() === REPORT_MARKER) {
            start = index;
            break;
        }
    }
    if (start < 0)
        return undefined;
    let summary;
    let touched;
    let left;
    for (const line of lines.slice(start + 1)) {
        const match = /^\s*(summary|touched|left)\s*:\s*(.*)$/i.exec(line);
        if (match === null)
            continue;
        const key = match[1].toLowerCase();
        const value = match[2].trim();
        if (key === 'summary') {
            if (value !== '' && !/^none$/i.test(value))
                summary = value;
            continue;
        }
        if (key === 'touched') {
            touched = splitPaths(value);
            continue;
        }
        if (value !== '' && !/^none$/i.test(value))
            left = value;
    }
    // A marker with no readable key under it is not a report; saying so beats
    // handing the decision an empty record that looks authoritative.
    if (summary === undefined && touched === undefined && left === undefined)
        return undefined;
    return {
        ...summary === undefined ? {} : { summary },
        touched: touched ?? [],
        ...left === undefined ? {} : { left },
    };
}
/** The instruction a worker receives, kept next to the parser it feeds. */
export const REPORT_INSTRUCTION = [
    'Your final message is relayed to the human. Write it in the task\'s language, short and factual:',
    '做了什么 (outcome), 怎么做的 (key steps), 结果 (concrete findings), 产物 (absolute paths, screenshots included).',
    'No acceptance step follows; this report is the answer. End with exactly this block and nothing after it:',
    REPORT_MARKER,
    'summary: what you actually did, one sentence, past tense',
    'touched: comma-separated paths you changed or created, or "none"',
    'left: anything still open, or "none"',
    'One short line each; do not repeat the block.',
    'The dispatcher decides whether to reuse this session or start a fresh one from these three fields, so '
        + 'a vague line costs the next task its context. Paths are what it matches on: write them out.',
];
//# sourceMappingURL=report.js.map