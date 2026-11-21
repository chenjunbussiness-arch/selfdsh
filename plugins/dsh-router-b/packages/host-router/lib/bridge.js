/**
 * The HTTP bridge between the durable router and the Web client.
 *
 * Why HTTP and not a Remote: the board's truth lives in this process, but the
 * panel runs in the browser. `ctx.webServer` is the supported seam that both
 * halves already share — the Web shell is served by it, so a same-origin
 * `fetch('/api/router/board')` needs no new transport, no Typert declaration,
 * and no authenticated hop of its own. Route registration is
 * `webServer.register(route)` (`@deepseek-ai/dsh-host-webserver/src/index.ts:445`
 * in the running 0.2.2-rc.3 build); a route carries a `handler` that owns the
 * `node:http` exchange, which is why SSE is possible at all
 * (`WebRoute`, same file `:52-58`).
 *
 * Two documents meet here and only this file knows both:
 *
 * - the router's own snapshot (`./snapshot.ts`), whose states are
 *   `queued | dispatched | running | reported | verified | failed | blocked | cancelled`;
 * - the panel's contract (five states, four tabs), which is narrower.
 *
 * The mapping is total and lossless: every row keeps its host state in
 * `hostState`, so nothing is collapsed away. In particular `reported` never
 * becomes `verified` — the whole point of the two-state design
 * (`./board.ts:12-18`) survives the translation.
 *
 * @module host-router/bridge
 */
import { stat } from 'node:fs/promises';
/** Path prefix every bridge route lives under. */
export const BRIDGE_BASE = '/api/router';
/** `GET` → the board document. */
export const BOARD_PATH = `${BRIDGE_BASE}/board`;
/** `POST` → publish demands. */
export const PUBLISH_PATH = `${BRIDGE_BASE}/publish`;
/** `POST` → record a human verification decision. */
export const VERIFY_PATH = `${BRIDGE_BASE}/verify`;
/** `POST` → enable or disable one partition. */
export const PARTITION_PATH = `${BRIDGE_BASE}/partition`;
/** `GET` → the 作战室 anchor session id (created or resumed on demand). */
export const ANCHOR_PATH = `${BRIDGE_BASE}/anchor`;
/** `GET` → server-sent change notifications. */
export const EVENTS_PATH = `${BRIDGE_BASE}/events`;
/** `GET` → tier settings + model options; `POST` → save tier settings. */
export const TIERS_PATH = `${BRIDGE_BASE}/tiers`;
/** Request body ceiling: demands and verdicts are small by construction. */
const MAX_BODY_BYTES = 256 * 1024;
/** Most demands one publish call may carry. */
const MAX_DEMANDS = 64;
/** How many bytes of the change file's timestamp the SSE route compares. */
const EVENTS_POLL_MS = 1_500;
/** SSE keep-alive interval; comment frames keep idle proxies from closing. */
const EVENTS_BEAT_MS = 20_000;
/**
 * Longest one stream stays open before the server ends it.
 *
 * The panel reconnects on its own (`retry: 3000`), so this costs one round trip
 * every half hour and bounds what an abandoned browser tab can leave behind: an
 * open response plus a poller watching the board file.
 */
const EVENTS_MAX_LIFETIME_MS = 30 * 60 * 1_000;
/** The host state → panel state table. Total: every host state has a row. */
export const STATE_TO_UI = {
    // Accepted, waiting for a worker slot: still the dispatch lane.
    queued: 'queued',
    // A child session exists but its log shows no turn yet. The panel has no
    // separate word for that, and "running" is the honest reading: a worker holds
    // it.
    dispatched: 'running',
    running: 'running',
    // The worker's own claim. NOT verified — the panel keeps its own lane for it.
    // No human acceptance step: a normal end is finished. `reported` is the
    // pre-`done` spelling of the same outcome on older rows.
    reported: 'verified',
    done: 'verified',
    verified: 'verified',
    // The worker errored, or acceptance failed: the panel's "sent back" state,
    // which keeps the reason and the attempt count.
    failed: 'rejected',
    // Parked on a human decision. Nothing runs, nothing finished: it is next up
    // again once someone decides.
    blocked: 'queued',
    // Cancelled on request. Terminal, and never done — the panel's "sent back"
    // state is the closest fit, and `hostState` still says `cancelled`.
    cancelled: 'rejected',
    // Stopped by a restart and waiting to be resumed from its own log: still work
    // in progress, not a result.
    interrupted: 'running',
};
/**
 * The panel state → tab table.
 *
 * Deliberately a function of the *panel* state rather than of the host state:
 * the tab strip only ever sees five values, so one table decides placement and
 * there is no second place for them to disagree.
 *
 * `scheduled` has no producer today: the router dispatches as soon as a slot is
 * free and has no scheduler, so no row can be "not due yet". The value stays in
 * the union because the panel's tab exists.
 */
export const BUCKET_OF_STATE = {
    queued: 'up-next',
    running: 'active',
    reported: 'active',
    verified: 'resolved',
    rejected: 'resolved',
};
/** A failed HTTP call, carrying the status and the stable error code the client prints. */
export class BridgeError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'BridgeError';
    }
}
/**
 * Normalise a credential provider's source layer onto the panel's four values.
 *
 * The local provider reports finer layers — `env`, `file`, `project-env`,
 * `user-env` (`@deepseek-ai/dsh-credentials/src/index.ts:121`) — while the panel
 * draws an origin badge with four states. Anything unrecognised reads as
 * `unknown` rather than being forced into a wrong badge.
 * @param raw - the provider's source string, if it supplied one.
 * @returns the panel's coarser value.
 */
export function credentialSourceOf(raw) {
    if (typeof raw !== 'string' || raw.trim() === '')
        return 'unknown';
    const text = raw.trim().toLowerCase();
    if (text === 'unset' || text === 'none' || text === 'absent')
        return 'unset';
    if (text.includes('file'))
        return 'file';
    if (text.includes('env'))
        return 'env';
    return 'unknown';
}
/** The worker id a row's worker appears under in the roster. */
function workerIdOf(task) {
    return `w:${task.id}`;
}
/** Whether a row's worker is still occupying a slot. */
function isOccupying(task) {
    return task.state === 'dispatched' || task.state === 'running';
}
/**
 * Build the roster for one partition.
 *
 * The router has no long-lived worker entity — a worker *is* a task's child
 * session — so the roster is derived, and each derivation is stated:
 *
 * - a row holding a slot becomes `busy` (it will release the slot when it settles);
 * - a row whose worker self-reported becomes `released`: the capacity is already
 *   back (a reported row holds no slot, `./index.ts` `holdsSlot`), and the panel
 *   must not draw it as "still burning a machine";
 * - every remaining slot becomes an `online` (idle, dispatchable) worker.
 *
 * `offline` is never emitted: the router has no reachability probe, and claiming
 * a worker is unreachable without evidence would be a guess.
 * @param partition - static partition facts.
 * @param scoped - the partition's task rows.
 * @param now - clock for the elapsed-time estimate, in milliseconds.
 * @returns the roster in a stable order.
 */
function rosterOf(partition, scoped, now) {
    const busy = scoped.filter(isOccupying);
    const reported = scoped.filter(task => task.state === 'reported' || task.state === 'done');
    const workers = [];
    for (const task of busy) {
        const startedAt = Date.parse(task.createdAt);
        workers.push({
            id: workerIdOf(task),
            name: task.worker ?? `worker-${String(workers.length + 1)}`,
            presence: 'busy',
            activity: task.subject,
            ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
            ...Number.isFinite(startedAt) ? { elapsedSeconds: Math.max(0, Math.round((now - startedAt) / 1000)) } : {},
        });
    }
    for (const task of reported) {
        workers.push({
            id: workerIdOf(task),
            name: task.worker ?? `worker-${String(workers.length + 1)}`,
            presence: 'released',
            ...task.sessionId === undefined ? {} : { sessionId: task.sessionId },
        });
    }
    // `slots === 0` means no cap: there is no fixed set of idle seats to draw, so none are.
    for (let slot = busy.length; slot < partition.slots; slot++) {
        workers.push({
            id: `w:${partition.name}:slot-${String(slot + 1)}`,
            name: `worker-${String(slot + 1)}`,
            presence: 'online',
        });
    }
    return workers;
}
/**
 * Translate one host row into the panel's task shape.
 * @param task - the folded host row.
 * @returns the panel task; `hostState` retains everything the mapping narrows.
 */
function taskOf(task) {
    const state = STATE_TO_UI[task.state];
    const holdsRoster = isOccupying(task) || task.state === 'reported' || task.state === 'done';
    const active = task.todos.current;
    return {
        id: task.id,
        title: task.subject,
        partitionId: task.partition,
        hostState: task.state,
        state,
        bucket: BUCKET_OF_STATE[state],
        todos: task.todos.todos ?? [],
        todoProgress: {
            done: task.todos.done,
            total: task.todos.total,
            ratio: task.todos.ratio,
            ...active === undefined ? {} : { current: active },
        },
        progress: task.progress,
        updatedAt: task.updatedAt,
        requestedAt: task.createdAt,
        // The board keeps one timestamp per row; it is the report time while the
        // row sits in `reported` and the acceptance time while it sits in `verified`.
        ...task.state === 'reported' || task.state === 'done' ? { reportedAt: task.updatedAt } : {},
        ...task.state === 'verified' || task.state === 'done' || task.state === 'reported' ? { verifiedAt: task.updatedAt } : {},
        // The host counts starts from zero (nobody has started it yet); the panel
        // counts attempts from one.
        attempt: Math.max(1, task.attempts),
        level: task.level,
        ...task.parentId === undefined ? {} : { parentId: task.parentId },
        priority: task.priority,
        ...task.activity === undefined ? {} : {
            toolCalls: task.activity.toolCalls,
            ...task.activity.lastTool === undefined ? {} : { lastTool: task.activity.lastTool },
            ...task.activity.lastActivityAt === undefined ? {} : { lastActivityAt: task.activity.lastActivityAt },
            ...task.activity.startedAt === undefined ? {} : { startedAt: task.activity.startedAt },
        },
        ...holdsRoster ? { workerId: workerIdOf(task) } : {},
        ...task.sessionId === undefined ? {} : { workerSessionId: task.sessionId },
        ...state === 'rejected' ? { rejectionReason: task.error ?? 'acceptance did not pass' } : {},
        ...task.result === undefined ? {} : { result: task.result },
        ...task.verifyOutput === undefined ? {} : { verifyOutput: task.verifyOutput },
        ...task.error === undefined ? {} : { error: task.error },
        ...task.tier === undefined ? {} : { tier: task.tier },
        ...task.tierSource === undefined ? {} : { tierSource: task.tierSource },
        ...task.tierReason === undefined ? {} : { tierReason: task.tierReason },
        ...task.provider === undefined ? {} : { provider: task.provider },
        ...task.model === undefined ? {} : { model: task.model },
        ...task.reasoningEffort === undefined ? {} : { reasoningEffort: task.reasoningEffort },
    };
}
/** Newest first, with the id as a tie-break so the order is stable. */
function byNewest(left, right) {
    const at = Date.parse(left.updatedAt);
    const bt = Date.parse(right.updatedAt);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt)
        return bt - at;
    return left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
}
/**
 * Fold the host snapshot into the panel's document.
 *
 * Pure apart from the clock, so the mapping can be asserted in a test without a
 * harness, a socket, or a browser.
 * @param input - host snapshot plus the facts the snapshot does not carry.
 * @returns the document `GET /api/router/board` answers with.
 */
export function boardDocument(input) {
    const now = input.now ?? Date.now();
    const tasks = input.snapshot.tasks.map(taskOf).sort(byNewest);
    const buckets = { active: 0, 'up-next': 0, scheduled: 0, resolved: 0 };
    for (const task of tasks)
        buckets[task.bucket] += 1;
    const partitions = input.partitions.map((partition) => {
        const scopedTasks = input.snapshot.tasks.filter(task => task.partition === partition.name);
        const scopedViews = tasks.filter(task => task.partitionId === partition.name);
        return {
            id: partition.name,
            name: partition.name,
            repo: partition.dir,
            path: partition.dir,
            enabled: input.isEnabled(partition.name),
            workerCount: partition.slots,
            liveWorkers: scopedViews.filter(task => task.state === 'running').length,
            queuedCount: scopedViews.filter(task => task.state === 'queued').length,
            // No human acceptance step: nothing waits on the user.
            unreviewedCount: 0,
            taskCount: scopedViews.length,
            manager: {
                id: `mgr:${partition.name}`,
                // A partition without a manager seat is routed by the router itself;
                // naming it `router` says so instead of inventing an agent.
                name: partition.managerEnabled ? 'manager' : 'router',
                presence: scopedTasks.some(task => task.level === 'manager' && isOccupying(task)) ? 'busy' : 'online',
                dispatched: scopedViews.filter(task => task.level === 'worker').length,
                awaitingVerification: 0,
            },
            workers: rosterOf(partition, scopedTasks, now),
        };
    });
    // The router has no demand queue: it resolves a partition at enqueue time, so
    // a demand never waits unrouted. The flow is therefore derived one row per
    // root task, and `taskIds` is exact rather than reconstructed.
    const demands = input.snapshot.tasks
        .filter(task => task.parentId === undefined)
        .map((task) => ({
        id: `dmd:${task.id}`,
        text: task.subject,
        publishedAt: task.createdAt,
        partitionId: task.partition,
        routingReason: `${task.reason}: ${task.because.join('; ')}`,
        taskIds: [task.id],
    }))
        .sort((left, right) => byNewest({ updatedAt: left.publishedAt, id: left.id }, { updatedAt: right.publishedAt, id: right.id }));
    return {
        version: 2,
        fetchedAt: new Date(now).toISOString(),
        partitions,
        tasks,
        demands,
        counts: input.snapshot.counts,
        buckets,
        credentials: input.credentials,
        origin: 'host',
    };
}
/** Answer one exchange with JSON. */
function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    res.end(body);
}
/** Answer a wrong method, naming the one route that exists. */
function sendMethodNotAllowed(res, allow) {
    res.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'method-not-allowed', message: `use ${allow}` } }));
}
/**
 * Read one JSON request body, bounded.
 *
 * The `application/json` content type is required, exactly as the shipped
 * `dsh-host-open-in-app` routes require it
 * (`…/dsh-host-open-in-app/src/index.ts:250-256`): a browser then has to
 * preflight a cross-origin POST, so a random page cannot drive the router
 * without the server ever opting in.
 * @param req - the request.
 * @returns the decoded body.
 * @throws {BridgeError} 415 for a wrong content type, 413 when too large, 400 when unparseable.
 */
async function readJsonBody(req) {
    const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase();
    if (essence !== 'application/json') {
        throw new BridgeError(415, 'unsupported-media-type', 'content-type must be application/json');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > MAX_BODY_BYTES)
            throw new BridgeError(413, 'body-too-large', `request body exceeds ${String(MAX_BODY_BYTES)} bytes`);
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text === '')
        throw new BridgeError(400, 'bad-request', 'request body is empty');
    try {
        return JSON.parse(text);
    }
    catch {
        throw new BridgeError(400, 'bad-request', 'request body is not JSON');
    }
}
/** Narrow a decoded body to a plain object. */
function objectOf(value, field) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new BridgeError(400, 'bad-request', `${field} must be an object`);
    }
    return value;
}
/** Wrap a handler so a throw becomes a JSON error instead of a dropped socket. */
function guard(deps, label, run) {
    return async (req, res) => {
        try {
            await run(req, res);
        }
        catch (error) {
            const failure = error instanceof BridgeError
                ? error
                : new BridgeError(500, 'internal', error instanceof Error ? error.message : String(error));
            if (!(error instanceof BridgeError)) {
                deps.logger.warn(`host-router: ${label} failed: ${String(error)}`);
            }
            if (res.headersSent) {
                res.destroy();
                return;
            }
            sendJson(res, failure.status, { error: { code: failure.code, message: failure.message } });
        }
    };
}
/** `GET /api/router/board`. */
async function boardRoute(req, res, deps) {
    if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
    }
    const [snapshot, credentials] = await Promise.all([deps.snapshot(), deps.credentials()]);
    sendJson(res, 200, boardDocument({
        snapshot,
        partitions: deps.partitions,
        isEnabled: deps.isEnabled,
        credentials,
    }));
}
/** `POST /api/router/publish` with `{ demands: string[] }`. */
async function publishRoute(req, res, deps) {
    if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST');
        return;
    }
    const body = objectOf(await readJsonBody(req), 'body');
    const raw = body.demands;
    if (!Array.isArray(raw))
        throw new BridgeError(400, 'bad-request', 'demands must be an array of strings');
    if (raw.length > MAX_DEMANDS)
        throw new BridgeError(400, 'bad-request', `at most ${String(MAX_DEMANDS)} demands per call`);
    const texts = raw.map((entry, index) => {
        if (typeof entry !== 'string')
            throw new BridgeError(400, 'bad-request', `demands[${String(index)}] must be a string`);
        return entry.trim();
    }).filter(text => text !== '');
    if (texts.length === 0)
        throw new BridgeError(400, 'bad-request', 'demands holds no non-empty text');
    sendJson(res, 200, await deps.publish(texts));
}
/** `GET /api/router/anchor`: the 作战室 session id. */
async function anchorRoute(req, res, deps) {
    if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
    }
    if (deps.anchor === undefined)
        throw new BridgeError(404, 'not-found', 'this router has no anchor session');
    sendJson(res, 200, await deps.anchor());
}
/** `POST /api/router/verify` with `{ taskId, verdict, note? }`. */
async function verifyRoute(req, res, deps) {
    if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST');
        return;
    }
    const body = objectOf(await readJsonBody(req), 'body');
    if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
        throw new BridgeError(400, 'bad-request', 'taskId must be a non-empty string');
    }
    const verdict = body.verdict;
    if (verdict !== 'verified' && verdict !== 'rejected') {
        throw new BridgeError(400, 'bad-request', 'verdict must be "verified" or "rejected"');
    }
    if (body.note !== undefined && typeof body.note !== 'string') {
        throw new BridgeError(400, 'bad-request', 'note must be a string when present');
    }
    const updated = await deps.verify(body.taskId.trim(), verdict, body.note);
    sendJson(res, 200, { ok: true, task: updated });
}
/** `POST /api/router/partition` with `{ id, enabled }`. */
async function partitionRoute(req, res, deps) {
    if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'POST');
        return;
    }
    const body = objectOf(await readJsonBody(req), 'body');
    if (typeof body.id !== 'string' || body.id.trim() === '') {
        throw new BridgeError(400, 'bad-request', 'id must be a non-empty string');
    }
    if (typeof body.enabled !== 'boolean')
        throw new BridgeError(400, 'bad-request', 'enabled must be a boolean');
    const updated = await deps.setPartitionState(body.id.trim(), body.enabled);
    sendJson(res, 200, { ok: true, partition: updated });
}
/** `GET|POST /api/router/tiers` — difficulty-tier model routes. */
async function tiersRoute(req, res, deps) {
    if (deps.tiers === undefined)
        throw new BridgeError(404, 'not-found', 'tier settings are not available');
    if (req.method === 'GET') {
        sendJson(res, 200, await deps.tiers.read());
        return;
    }
    if (req.method !== 'POST') {
        sendMethodNotAllowed(res, 'GET, POST');
        return;
    }
    const body = objectOf(await readJsonBody(req), 'body');
    sendJson(res, 200, await deps.tiers.write(body));
}
/**
 * `GET /api/router/events` — server-sent change notifications.
 *
 * The payload carries no board data on purpose: the panel re-reads
 * `/api/router/board` itself, so one signal cannot disagree with the document
 * it is announcing. The signal is the board file's mtime, which moves on every
 * write (`TaskBoard.flush`), so a change made by any path — a tool, a settlement,
 * this bridge — produces exactly one event.
 *
 * A client that cannot keep the stream open is expected to fall back to polling;
 * the client half does that.
 */
function eventsRoute(req, res, deps) {
    if (req.method !== 'GET') {
        sendMethodNotAllowed(res, 'GET');
        return;
    }
    res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        // nginx-style buffers would hold every frame; the shell is served directly,
        // but the header costs nothing and stops a deployment surprise.
        'x-accel-buffering': 'no',
    });
    let closed = false;
    let poll;
    let beat;
    let expiry;
    function close() {
        if (closed)
            return;
        closed = true;
        if (poll !== undefined)
            clearInterval(poll);
        if (beat !== undefined)
            clearInterval(beat);
        if (expiry !== undefined)
            clearTimeout(expiry);
        if (!res.writableEnded) {
            try {
                res.end();
            }
            catch {
                // The peer is already gone; nothing left to close.
            }
        }
    }
    function write(frame) {
        if (closed || res.writableEnded || res.destroyed)
            return;
        try {
            res.write(frame);
        }
        catch {
            close();
        }
    }
    // A reconnecting EventSource waits this long; the panel's own poll is slower.
    write('retry: 3000\n\n');
    write('event: hello\ndata: {}\n\n');
    let lastStamp = 0;
    const check = async () => {
        try {
            const info = await stat(deps.changeFile);
            if (lastStamp !== 0 && info.mtimeMs !== lastStamp) {
                write(`event: changed\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
            }
            lastStamp = info.mtimeMs;
        }
        catch {
            // The board file does not exist until the first write: no change to report.
            lastStamp = 0;
        }
    };
    void check();
    poll = setInterval(() => { void check(); }, EVENTS_POLL_MS);
    beat = setInterval(() => { write(': ping\n\n'); }, EVENTS_BEAT_MS);
    expiry = setTimeout(close, EVENTS_MAX_LIFETIME_MS);
    // Timers must not keep the process alive on their own.
    poll.unref();
    beat.unref();
    expiry.unref();
    req.on('close', close);
    res.on('close', close);
    res.on('error', close);
}
/**
 * Build the bridge's routes.
 *
 * Pure construction: registering them (and disposing them) belongs to the
 * plugin activation, so a test can drive each handler with a fake exchange.
 * @param deps - what the handlers act on.
 * @returns one route per endpoint, in path order.
 */
export function createRoutes(deps) {
    return [
        { kind: 'exact', path: BOARD_PATH, handler: guard(deps, BOARD_PATH, (req, res) => boardRoute(req, res, deps)) },
        { kind: 'exact', path: PUBLISH_PATH, handler: guard(deps, PUBLISH_PATH, (req, res) => publishRoute(req, res, deps)) },
        { kind: 'exact', path: ANCHOR_PATH, handler: guard(deps, ANCHOR_PATH, (req, res) => anchorRoute(req, res, deps)) },
        { kind: 'exact', path: VERIFY_PATH, handler: guard(deps, VERIFY_PATH, (req, res) => verifyRoute(req, res, deps)) },
        { kind: 'exact', path: PARTITION_PATH, handler: guard(deps, PARTITION_PATH, (req, res) => partitionRoute(req, res, deps)) },
        { kind: 'exact', path: TIERS_PATH, handler: guard(deps, TIERS_PATH, (req, res) => tiersRoute(req, res, deps)) },
        { kind: 'exact', path: EVENTS_PATH, handler: guard(deps, EVENTS_PATH, async (req, res) => { eventsRoute(req, res, deps); }) },
    ];
}
//# sourceMappingURL=bridge.js.map