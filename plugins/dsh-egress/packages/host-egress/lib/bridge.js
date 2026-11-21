/**
 * The HTTP bridge between the egress store and the Web client.
 *
 * Routes (all under `/api/egress`):
 *
 * - `GET  /state`    the redacted state document;
 * - `PUT  /exit`     create or update one exit (body: name, type, host, port, optional username/password);
 * - `DELETE /exit`   delete one exit (query or body: `id`); refused while it is bound or the default;
 * - `PUT  /binding`  bind a host to an exit (`{ host, exit }`; host `*` is the default exit; `exit: null` removes a binding);
 * - `POST /probe`    probe one exit against the fixed endpoint (`{ id }`).
 *
 * Writes require `application/json` (a cross-origin page then needs a CORS
 * preflight it cannot pass) and are rejected when the browser says the request
 * is cross-site. The same-origin Web shell is already behind DSH's own token
 * and the gate in front of it; the bridge adds no second login.
 *
 * Reads never return a credential, and there is no write path from the agent:
 * the tool in `./tool.ts` is read-only.
 *
 * @module host-egress/bridge
 */
import { buildState } from "./state.js";
import { DIRECT_ID, ValidationError, validateCredential, validateHost, validateId, validateName, validatePort, validateType, } from "./validate.js";
/** Path prefix every route lives under. */
export const BRIDGE_BASE = '/api/egress';
/** `GET`. */
export const STATE_PATH = `${BRIDGE_BASE}/state`;
/** `PUT` / `DELETE`. */
export const EXIT_PATH = `${BRIDGE_BASE}/exit`;
/** `PUT`. */
export const BINDING_PATH = `${BRIDGE_BASE}/binding`;
/** `POST`. */
export const PROBE_PATH = `${BRIDGE_BASE}/probe`;
/** Request body ceiling. */
const MAX_BODY_BYTES = 16 * 1024;
/** Most exits one profile may hold; a sanity bound, not a product limit. */
export const MAX_EXITS = 200;
/** A failed call: status plus the stable code the client prints. */
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
/** Answer JSON. */
function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    res.end(body);
}
/** Reject a method the route does not serve. */
function methodNotAllowed(res, allow) {
    res.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'method-not-allowed', message: `use ${allow}` } }));
}
/** Read one bounded JSON body. */
async function readJsonBody(req) {
    const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (essence !== 'application/json')
        throw new BridgeError(415, 'unsupported-media-type', 'content-type must be application/json');
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
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new BridgeError(400, 'bad-request', 'request body is not JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new BridgeError(400, 'bad-request', 'body must be an object');
    return parsed;
}
/** Refuse writes the browser marks as cross-site. */
function requireSameSite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site')
        throw new BridgeError(403, 'cross-site', 'cross-site requests are not accepted');
}
/** Wrap a handler so a throw becomes a JSON error. */
function guard(deps, label, run) {
    return async (req, res) => {
        try {
            await run(req, res);
        }
        catch (error) {
            let failure;
            if (error instanceof BridgeError)
                failure = error;
            else if (error instanceof ValidationError)
                failure = new BridgeError(error.code === 'not-found' ? 404 : 400, error.code, error.message);
            else {
                failure = new BridgeError(500, 'internal', 'internal error');
                deps.logger.warn(`dsh-egress: ${label} failed: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : 'unknown'}`);
            }
            if (res.headersSent) {
                res.destroy();
                return;
            }
            sendJson(res, failure.status, { error: { code: failure.code, message: failure.message } });
        }
    };
}
/** Current state document. */
function state(deps) {
    return buildState(deps.runtime, deps.hookActive(), deps.providers);
}
/** `PUT /exit`. */
async function putExit(req, res, deps) {
    requireSameSite(req);
    const body = await readJsonBody(req);
    const name = validateName(body['name']);
    const type = validateType(body['type']);
    const host = validateHost(body['host']);
    const port = validatePort(body['port']);
    const hasUser = typeof body['username'] === 'string' && body['username'] !== '';
    const hasPass = typeof body['password'] === 'string' && body['password'] !== '';
    const clearAuth = body['clearAuth'] === true;
    if (hasUser !== hasPass && !(hasUser && !hasPass) && !(clearAuth)) {
        throw new BridgeError(400, 'bad-credential', 'username and password go together');
    }
    const id = body['id'] === undefined || body['id'] === null ? undefined : validateId(body['id']);
    await deps.runtime.store.mutate((draft) => {
        const existing = id === undefined ? undefined : draft.exits.find(candidate => candidate.id === id);
        if (id !== undefined && existing === undefined)
            throw new ValidationError('not-found', `no exit "${id}"`);
        if (existing === undefined && draft.exits.length >= MAX_EXITS)
            throw new ValidationError('too-many', `at most ${String(MAX_EXITS)} exits`);
        if (draft.exits.some(candidate => candidate.name.toLowerCase() === name.toLowerCase() && candidate.id !== existing?.id)) {
            throw new ValidationError('duplicate-name', `an exit named "${name}" already exists`);
        }
        let auth = existing?.auth;
        if (clearAuth)
            auth = undefined;
        else if (hasUser) {
            // A username without a new password keeps the stored password, so renaming a user never re-asks for the secret.
            const password = hasPass ? validateCredential(body['password'], 'password') : existing?.auth?.password;
            if (password === undefined)
                throw new ValidationError('bad-credential', 'password is required with a new username');
            auth = { username: validateCredential(body['username'], 'username'), password };
        }
        else if (hasPass) {
            if (existing?.auth === undefined)
                throw new ValidationError('bad-credential', 'username is required with a password');
            auth = { username: existing.auth.username, password: validateCredential(body['password'], 'password') };
        }
        const next = {
            id: existing?.id ?? newId(name, draft.exits),
            name, type, host, port,
            ...auth === undefined ? {} : { auth },
            createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        const at = existing === undefined ? -1 : draft.exits.indexOf(existing);
        if (at >= 0)
            draft.exits[at] = next;
        else
            draft.exits.push(next);
        // An edited exit's old probe no longer describes it.
        delete draft.probes[next.id];
    });
    sendJson(res, 200, state(deps));
}
/** Derive a unique slug id from a name. */
function newId(name, exits) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'exit';
    const root = base === DIRECT_ID ? 'exit' : base;
    const taken = new Set(exits.map(exit => exit.id));
    if (!taken.has(root))
        return root;
    for (let n = 2; n < 1000; n++)
        if (!taken.has(`${root}-${String(n)}`))
            return `${root}-${String(n)}`;
    return `${root}-${Date.now().toString(36)}`;
}
/** `DELETE /exit`. */
async function deleteExit(req, res, deps) {
    requireSameSite(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const raw = url.searchParams.get('id') ?? (String(req.headers['content-type'] ?? '').startsWith('application/json') ? (await readJsonBody(req))['id'] : undefined);
    const id = validateId(raw);
    await deps.runtime.store.mutate((draft) => {
        if (!draft.exits.some(candidate => candidate.id === id))
            throw new ValidationError('not-found', `no exit "${id}"`);
        const users = Object.entries(draft.bindings).filter(([, exit]) => exit === id).map(([host]) => host);
        if (draft.defaultExit === id)
            users.push('* (default)');
        if (users.length > 0)
            throw new ValidationError('in-use', `exit "${id}" is still used by ${users.join(', ')}; rebind them first`);
        draft.exits = draft.exits.filter(candidate => candidate.id !== id);
        delete draft.probes[id];
    });
    deps.runtime.forget(id);
    sendJson(res, 200, state(deps));
}
/** `PUT /binding`. */
async function putBinding(req, res, deps) {
    requireSameSite(req);
    const body = await readJsonBody(req);
    const rawHost = body['host'];
    const isDefault = rawHost === '*';
    const host = isDefault ? '*' : validateHost(rawHost);
    const exit = body['exit'];
    if (exit !== null && typeof exit !== 'string')
        throw new BridgeError(400, 'bad-request', 'exit must be an exit id, "direct" or null');
    if (exit === null && isDefault)
        throw new BridgeError(400, 'bad-request', 'the default exit cannot be removed; choose one');
    await deps.runtime.store.mutate((draft) => {
        if (exit !== null && exit !== DIRECT_ID && !draft.exits.some(candidate => candidate.id === exit)) {
            throw new ValidationError('not-found', `no exit "${exit}"`);
        }
        if (isDefault)
            draft.defaultExit = exit;
        else if (exit === null)
            delete draft.bindings[host];
        else
            draft.bindings[host] = exit;
    });
    sendJson(res, 200, state(deps));
}
/** `POST /probe`. */
async function postProbe(req, res, deps) {
    requireSameSite(req);
    const body = await readJsonBody(req);
    const raw = body['id'];
    const id = raw === DIRECT_ID ? DIRECT_ID : validateId(raw);
    // Only the id is read: there is no URL field, so no caller can aim a probe elsewhere.
    const result = await deps.runtime.probe(id);
    sendJson(res, 200, { id, result, state: state(deps) });
}
/**
 * Build the bridge's routes.
 * @param deps - what the handlers act on.
 * @returns one route per endpoint.
 */
export function createRoutes(deps) {
    return [
        {
            kind: 'exact', path: STATE_PATH,
            handler: guard(deps, STATE_PATH, async (req, res) => {
                if (req.method !== 'GET') {
                    methodNotAllowed(res, 'GET');
                    return;
                }
                sendJson(res, 200, state(deps));
            }),
        },
        {
            kind: 'exact', path: EXIT_PATH,
            handler: guard(deps, EXIT_PATH, async (req, res) => {
                if (req.method === 'PUT')
                    await putExit(req, res, deps);
                else if (req.method === 'DELETE')
                    await deleteExit(req, res, deps);
                else
                    methodNotAllowed(res, 'PUT, DELETE');
            }),
        },
        {
            kind: 'exact', path: BINDING_PATH,
            handler: guard(deps, BINDING_PATH, async (req, res) => {
                if (req.method !== 'PUT') {
                    methodNotAllowed(res, 'PUT');
                    return;
                }
                await putBinding(req, res, deps);
            }),
        },
        {
            kind: 'exact', path: PROBE_PATH,
            handler: guard(deps, PROBE_PATH, async (req, res) => {
                if (req.method !== 'POST') {
                    methodNotAllowed(res, 'POST');
                    return;
                }
                await postProbe(req, res, deps);
            }),
        },
    ];
}
