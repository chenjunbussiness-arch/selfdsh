/**
 * Durable task board: the only source of truth about dispatched work.
 *
 * Why a file and not memory: the subagent manager's activations are
 * process-local (`resident` is a plain Map keyed by child id), so a restarted
 * harness forgets every live child and can never receive their settlement.
 * A board that lived only in memory would therefore strand exactly the tasks a
 * human most wants to see. Reads happen on demand, writes are atomic
 * (temp + rename), and a board that fails to parse is moved aside instead of
 * throwing — an unreadable board must not take the router down with it.
 *
 * Why `reported` and `verified` are separate states: a worker's closing message
 * is a report about work the worker cannot independently validate. The
 * measured failure rate of self-reported delegation success is high enough
 * (arXiv:2611.04100 reports 3 of 16 delegations recording failure as done) that
 * treating a report as truth would corrupt every downstream decision. `reported`
 * means "a claim exists"; `verified` means "an acceptance command passed".
 * Nothing in this plugin calls `reported` done.
 *
 * @module host-router/board
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
/** Truncation bound for stored child text; the full session log stays on disk. */
export const RESULT_LIMIT = 6_000;
/** Keep the tail of long text: build errors live at the end. */
export function tail(text, limit = RESULT_LIMIT) {
    return text.length <= limit ? text : `…(${String(text.length - limit)} chars dropped)\n${text.slice(-limit)}`;
}
/** One-letter state marker for the compact board. */
export function mark(state) {
    switch (state) {
        case 'queued': return '[ ]';
        case 'dispatched': return '[>]';
        case 'running': return '[~]';
        case 'reported': return '[x]';
        case 'done': return '[x]';
        case 'verified': return '[x]';
        case 'failed': return '[!]';
        case 'blocked': return '[B]';
        case 'cancelled': return '[-]';
        case 'interrupted': return '[^]';
    }
}
/** States a dispatched child can still be occupying a slot in. */
export function isOpen(state) {
    return state === 'queued' || state === 'dispatched' || state === 'running' || state === 'reported'
        || state === 'interrupted';
}
/** Order tasks for execution: priority first, then arrival. */
export function byExecutionOrder(left, right) {
    if (left.priority !== right.priority)
        return right.priority - left.priority;
    const at = Date.parse(left.createdAt);
    const bt = Date.parse(right.createdAt);
    if (at !== bt)
        return at - bt;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
/** Render the board for a model or a human. */
export function summarize(tasks, options = {}) {
    if (tasks.length === 0) {
        return options.partition === undefined
            ? '(board is empty)'
            : `(partition "${options.partition}" has no tasks)`;
    }
    const counts = new Map();
    for (const task of tasks)
        counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
    const tally = [...counts.entries()].map(([state, count]) => `${state}=${String(count)}`).join(' ');
    const header = `${String(tasks.length)} task(s): ${tally}. `
        + '`done` means the worker finished and its report is recorded (`reported` rows are older, also finished).';
    const rows = tasks.flatMap((task) => {
        const age = Math.max(0, Math.round((Date.now() - Date.parse(task.updatedAt)) / 1000));
        const parent = task.parentId === undefined ? '' : ` <- ${task.parentId}`;
        const worker = task.worker === undefined ? '-' : task.worker;
        const row = `${mark(task.state)} ${task.id} ${task.partition}/${task.level} ${worker} `
            + `p${String(task.priority)} ${task.subject}${parent} (${String(age)}s)`;
        // What the worker reported is what the next routing decision reads, so the
        // board shows it rather than making the caller open each row.
        const did = task.summary === undefined ? '' : `    did: ${task.summary}`;
        const touched = (task.touched?.length ?? 0) === 0
            ? ''
            : `    touched: ${task.touched.slice(0, 8).join(', ')}`
                + (task.touched.length > 8 ? ` +${String(task.touched.length - 8)} more` : '');
        return did === '' && touched === '' ? [row] : [row, did, touched];
    });
    return [header, ...rows].join('\n');
}
/** Error text on a row the harness stopped mid-flight; the session itself is intact. */
export const INTERRUPTED_NOTE = 'the harness stopped while this task was in flight; its session will be resumed from its log';
/** The board file. One instance per plugin activation. */
export class TaskBoard {
    file;
    runToken;
    tasks = [];
    partitions = {};
    constructor(file, runToken) {
        this.file = file;
        this.runToken = runToken;
    }
    /**
     * Open or create `<dir>/board.json`.
     * @param dir - directory holding the board document.
     * @param runToken - identity of the opening process; rows dispatched by any
     *   other token are treated as orphaned. Omitted disables reconciliation, which
     *   is what a read-only viewer or a test wants.
     */
    static async open(dir, runToken) {
        const file = join(dir, 'board.json');
        await mkdir(dirname(file), { recursive: true });
        const board = new TaskBoard(file, runToken);
        await board.load();
        return board;
    }
    /** Every task in insertion order. Callers sort for their own view. */
    list() {
        return this.tasks;
    }
    /** Tasks of one partition, in execution order. */
    inPartition(name) {
        return this.tasks.filter(task => task.partition === name).sort(byExecutionOrder);
    }
    /** Tasks created by one manager (or belonging under one parent). */
    childrenOf(id) {
        return this.tasks.filter(task => task.parentId === id);
    }
    /** One task by id. */
    get(id) {
        return this.tasks.find(task => task.id === id);
    }
    /** Durable record for one partition. */
    partitionRecord(name) {
        return this.partitions[name] ?? {};
    }
    /** Insert one task and persist before returning. */
    async add(task) {
        this.tasks = [...this.tasks, task];
        await this.flush();
        return task;
    }
    /**
     * Merge a patch into one task and persist.
     * @param id - task id.
     * @param change - fields to replace.
     * @returns the updated task.
     * @throws when the id is unknown, which means two writers disagree about the board.
     */
    async patch(id, change) {
        const index = this.tasks.findIndex(task => task.id === id);
        if (index < 0)
            throw new Error(`host-router: unknown task ${id}`);
        const updated = {
            ...this.tasks[index],
            ...change,
            updatedAt: new Date().toISOString(),
        };
        this.tasks = [...this.tasks.slice(0, index), updated, ...this.tasks.slice(index + 1)];
        await this.flush();
        return updated;
    }
    /** Merge a patch into one partition record and persist. */
    async patchPartition(name, change) {
        const merged = { ...this.partitionRecord(name), ...change };
        this.partitions = { ...this.partitions, [name]: merged };
        await this.flush();
        return merged;
    }
    /** Append a human remark without touching state. */
    async note(id, text) {
        const task = this.get(id);
        if (task === undefined)
            throw new Error(`host-router: unknown task ${id}`);
        return await this.patch(id, { notes: [...task.notes ?? [], text] });
    }
    async load() {
        let raw;
        try {
            raw = await readFile(this.file, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed.tasks))
                throw new Error('missing tasks array');
            this.tasks = parsed.tasks;
            this.partitions = parsed.partitions !== null && typeof parsed.partitions === 'object'
                ? { ...parsed.partitions }
                : {};
            await this.reconcile();
        }
        catch {
            // Keep the bytes for forensics; starting empty beats refusing to start.
            await rename(this.file, `${this.file}.corrupt-${String(Date.now())}`).catch(() => { });
            this.tasks = [];
            this.partitions = {};
        }
    }
    /**
     * Re-file rows orphaned by a dead process.
     *
     * A `running` or `dispatched` row dispatched under a different process token has
     * no live session in this process and no settlement will arrive for it. Its
     * session log is still on disk, though, so a row that has a session becomes
     * `interrupted` (the router resumes that session after boot) and a row that never
     * got one goes back to `queued` (nothing ran, so starting it is not a redo).
     * Rows carrying this process's own token are left alone: they are in flight here.
     */
    async reconcile() {
        // A tokenless open is a read-only viewer (or a test): it must not rewrite
        // another process's in-flight rows just by looking at them.
        if (this.runToken === undefined)
            return;
        const orphaned = this.tasks.filter(task => (task.state === 'running' || task.state === 'dispatched')
            && task.runToken !== this.runToken);
        if (orphaned.length === 0)
            return;
        const now = new Date().toISOString();
        this.tasks = this.tasks.map((task) => {
            if (task.state !== 'running' && task.state !== 'dispatched')
                return task;
            if (task.runToken === this.runToken)
                return task;
            return task.sessionId === undefined
                ? { ...task, state: 'queued', updatedAt: now }
                : { ...task, state: 'interrupted', error: INTERRUPTED_NOTE, updatedAt: now };
        });
        await this.flush();
    }
    /** Tail of the write chain: concurrent patches share one temp path, so writes must not overlap. */
    writing = Promise.resolve();
    async flush() {
        const run = this.writing.then(() => this.flushNow());
        this.writing = run.catch(() => { });
        await run;
    }
    async flushNow() {
        const document = {
            version: 1,
            tasks: this.tasks,
            partitions: this.partitions,
        };
        const temp = `${this.file}.tmp-${String(process.pid)}`;
        await writeFile(temp, JSON.stringify(document, undefined, 2), 'utf8');
        try {
            await replaceFile(temp, this.file);
        }
        catch (error) {
            await unlink(temp).catch(() => { });
            throw error;
        }
    }
}
/**
 * Replace a file with its freshly written temporary sibling.
 *
 * On Windows, `rename` over a file that another process currently has open fails
 * with `EPERM` rather than replacing it. That is not a hypothetical here: the
 * board is written by the plugin and read on demand by a UI, so a reader can be
 * inside the same window. Retrying briefly keeps the atomic-replace guarantee
 * (a torn board is never observable) without turning reader contention into a
 * lost write.
 * @param from - temporary file holding the complete new document.
 * @param to - destination path.
 */
async function replaceFile(from, to) {
    const delays = [0, 5, 15, 40, 100, 200, 400];
    let lastError;
    for (const delay of delays) {
        if (delay > 0)
            await new Promise(resolve => setTimeout(resolve, delay));
        try {
            await rename(from, to);
            return;
        }
        catch (error) {
            lastError = error;
            const code = error.code;
            if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY' && code !== 'EEXIST')
                break;
        }
    }
    throw lastError;
}
/** Monotonic, sortable, human-readable task id. */
export function nextTaskId(sequence) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `t${stamp}-${String(sequence).padStart(3, '0')}`;
}
//# sourceMappingURL=board.js.map