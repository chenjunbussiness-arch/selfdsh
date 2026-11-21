/**
 * The request hook: choose an exit per target host, send through it, and fail
 * closed.
 *
 * Why `globalThis.fetch`: the pi-ai OpenAI-completions provider builds a new
 * OpenAI client for every request and that client resolves `fetch` at
 * construction (`openai/internal/shims.js getDefaultFetch`), so replacing the
 * global affects the very next model request and no restart is needed. See
 * `docs/RESEARCH.md`.
 *
 * The rules, in the order they are applied to one request:
 *
 * 1. A non-http(s) URL is none of this module's business and is passed on.
 * 2. A loopback target is passed on: it never leaves the machine, and routing
 *    the Web UI's own traffic through a proxy would loop.
 * 3. The target host picks an exit: its binding, else the default exit.
 * 4. `direct` means the process's own transport (the fetch that was installed
 *    before this hook). Anything else goes through an undici dispatcher built
 *    for that exit.
 * 5. If the exit is missing, the config is unreadable, the dispatcher cannot be
 *    built, or the proxy fails, the request REJECTS. There is no code path from
 *    "a proxy exit failed" to "connect directly".
 *
 * @module host-egress/dispatch
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { DIRECT_ID, ValidationError, hostPort, isLoopbackHost, scrub } from "./validate.js";
/** The only endpoint a probe ever contacts. Fixed in code, never user-supplied. */
export const PROBE_URL = 'https://ifconfig.me/ip';
/** Probe timeout in milliseconds. */
export const PROBE_TIMEOUT_MS = 8_000;
/** Connect timeout toward a proxy. */
const PROXY_CONNECT_TIMEOUT_MS = 10_000;
/** Size of the recent-requests ring. */
export const RING_SIZE = 100;
/** How many distinct hosts are remembered for the binding table. */
const SEEN_LIMIT = 64;
/** Why a request did not leave. Carries the exit so the message can name it. */
export class EgressError extends Error {
    exitId;
    constructor(message, exitId, options) {
        super(message, options);
        this.exitId = exitId;
        this.name = 'EgressError';
    }
}
/**
 * Load undici without importing it statically.
 *
 * The server's profile does not depend on undici; it is reachable only through
 * dsh-web's `NODE_PATH` (`@deepseek-ai/dsh-http-proxy` pulls it in). A CJS
 * `require` honours `NODE_PATH`, an ESM `import` does not, hence `createRequire`.
 * @param explicit - optional absolute path to an undici `index.js`.
 * @returns the module.
 * @throws {Error} when no usable undici is found.
 */
export function loadUndici(explicit) {
    const require = createRequire(import.meta.url);
    const candidates = [...explicit === undefined || explicit === '' ? [] : [explicit], 'undici'];
    const failures = [];
    for (const spec of candidates) {
        try {
            const module = require(spec);
            if (typeof module.fetch !== 'function' || typeof module.ProxyAgent !== 'function')
                throw new Error('missing fetch/ProxyAgent');
            let version;
            try {
                const pkgPath = spec === 'undici' ? 'undici/package.json' : join(dirname(spec), 'package.json');
                version = require(pkgPath).version;
            }
            catch { /* version is informational */ }
            return { module, source: spec, ...version === undefined ? {} : { version } };
        }
        catch (error) {
            failures.push(`${spec}: ${error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)}`);
        }
    }
    throw new Error(`undici is not available (${failures.join('; ')})`);
}
/**
 * Describe a failure in one short, secret-free line.
 * @param error - thrown value.
 * @param secrets - literal values to mask.
 * @returns text such as `ECONNREFUSED connect ECONNREFUSED 127.0.0.1:9`.
 */
export function describeError(error, secrets = []) {
    const parts = [];
    let current = error;
    for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
        const code = current.code;
        if (typeof code === 'string' && !parts.includes(code))
            parts.push(code);
        if (current.name === 'TimeoutError')
            parts.push('timeout');
        if (current.message !== '' && current.message !== 'fetch failed')
            parts.push(current.message);
        current = current.cause;
    }
    const text = parts.join(' ').trim();
    return scrub(text === '' ? 'network error' : text, secrets).slice(0, 200);
}
/** Whether a thrown value is an abort the caller asked for. */
function isAbort(error, signal) {
    if (signal?.aborted === true && !(signal.reason instanceof Error && signal.reason.name === 'TimeoutError'))
        return true;
    return error instanceof Error && error.name === 'AbortError';
}
/** Request-shaped input (a `Request`), tested structurally to survive cross-realm classes. */
function isRequestLike(value) {
    return typeof value === 'object' && value !== null && typeof value.url === 'string'
        && typeof value.method === 'string' && typeof value.arrayBuffer === 'function';
}
/** Decides, sends and records. One instance per plugin activation. */
export class EgressRuntime {
    options;
    undici;
    undiciError;
    dispatchers = new Map();
    ring = [];
    seen = new Map();
    constructor(options) {
        this.options = options;
    }
    /** The store behind this runtime. */
    get store() { return this.options.store; }
    /** Provider labels by host. */
    get providers() { return this.options.providers ?? new Map(); }
    /** The probe endpoint in force. */
    get probeUrl() { return this.options.testing?.probeUrl ?? PROBE_URL; }
    /** Newest first. */
    recent() { return [...this.ring].reverse(); }
    /** Hosts seen on the wire, newest first, with their last-seen time. */
    seenHosts() {
        return [...this.seen.entries()].map(([host, at]) => ({ host, at })).sort((a, b) => b.at.localeCompare(a.at));
    }
    /** What loading undici did: ok/version/error. Loads lazily on first call. */
    undiciStatus() {
        const loaded = this.tryUndici();
        return loaded === undefined
            ? { ok: false, error: this.undiciError ?? 'not loaded' }
            : { ok: true, source: loaded.source, ...loaded.version === undefined ? {} : { version: loaded.version } };
    }
    /** Close every cached dispatcher. */
    dispose() {
        for (const cached of this.dispatchers.values())
            void cached.dispatcher.close().catch(() => undefined);
        this.dispatchers.clear();
    }
    /**
     * Pick the exit for one host.
     * @param host - target host name, lower-case.
     * @returns direct, a proxy exit, or blocked with the reason.
     */
    resolve(host) {
        const snapshot = this.options.store.snapshot();
        if (snapshot.corrupt !== undefined) {
            return { kind: 'blocked', exitId: '?', reason: `the egress config is unreadable (${scrub(snapshot.corrupt)}); fix or delete ${this.options.store.file}` };
        }
        const config = snapshot.config;
        const id = config.bindings[host] ?? config.defaultExit;
        if (id === DIRECT_ID)
            return { kind: 'direct' };
        const exit = config.exits.find(candidate => candidate.id === id);
        if (exit === undefined)
            return { kind: 'blocked', exitId: id, reason: `exit "${id}" does not exist` };
        return { kind: 'proxy', exit };
    }
    /** Load undici once; remember the failure so every request reports it the same way. */
    tryUndici() {
        if (this.undici !== undefined)
            return this.undici;
        if (this.undiciError !== undefined)
            return undefined;
        try {
            this.undici = (this.options.loadUndici ?? (() => loadUndici(this.options.undiciPath)))();
        }
        catch (error) {
            this.undiciError = error instanceof Error ? error.message : String(error);
        }
        return this.undici;
    }
    /** Build or reuse the dispatcher of one exit; a changed exit gets a new one. */
    dispatcherFor(exit) {
        const fingerprint = JSON.stringify([exit.type, exit.host, exit.port, exit.auth?.username ?? '', exit.auth?.password ?? '']);
        const cached = this.dispatchers.get(exit.id);
        if (cached?.fingerprint === fingerprint)
            return cached.dispatcher;
        const loaded = this.tryUndici();
        if (loaded === undefined)
            throw new Error(`undici is not available: ${this.undiciError ?? 'unknown'}`);
        const requestTls = this.options.testing?.requestTls;
        let dispatcher;
        if (exit.type === 'socks5') {
            if (loaded.module.Socks5ProxyAgent === undefined)
                throw new Error('this undici has no Socks5ProxyAgent (need undici >= 7.x with SOCKS5 support)');
            dispatcher = new loaded.module.Socks5ProxyAgent(`socks5://${hostPort(exit.host, exit.port)}`, {
                connectTimeout: PROXY_CONNECT_TIMEOUT_MS,
                ...exit.auth === undefined ? {} : { username: exit.auth.username, password: exit.auth.password },
                ...requestTls === undefined ? {} : { requestTls },
            });
        }
        else {
            dispatcher = new loaded.module.ProxyAgent({
                uri: `${exit.type}://${hostPort(exit.host, exit.port)}`,
                connectTimeout: PROXY_CONNECT_TIMEOUT_MS,
                ...exit.auth === undefined ? {} : { token: `Basic ${Buffer.from(`${exit.auth.username}:${exit.auth.password}`).toString('base64')}` },
                ...requestTls === undefined ? {} : { requestTls },
            });
        }
        if (cached !== undefined)
            void cached.dispatcher.close().catch(() => undefined);
        this.dispatchers.set(exit.id, { fingerprint, dispatcher });
        return dispatcher;
    }
    /** Forget the dispatcher of a deleted exit. */
    forget(id) {
        const cached = this.dispatchers.get(id);
        if (cached === undefined)
            return;
        this.dispatchers.delete(id);
        void cached.dispatcher.close().catch(() => undefined);
    }
    record(entry) {
        const at = new Date().toISOString();
        this.ring.push({ at, ...entry });
        if (this.ring.length > RING_SIZE)
            this.ring.splice(0, this.ring.length - RING_SIZE);
        this.seen.delete(entry.host);
        this.seen.set(entry.host, at);
        if (this.seen.size > SEEN_LIMIT) {
            const oldest = this.seen.keys().next().value;
            if (oldest !== undefined)
                this.seen.delete(oldest);
        }
    }
    /**
     * The replacement for `globalThis.fetch`.
     * @param input - URL, URL string or Request.
     * @param init - fetch options.
     * @returns the response.
     * @throws {EgressError} when the chosen exit cannot carry the request.
     */
    async fetch(input, init) {
        let url;
        try {
            url = new URL(isRequestLike(input) ? input.url : String(input));
        }
        catch {
            return this.options.directFetch(input, init);
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return this.options.directFetch(input, init);
        const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (isLoopbackHost(host) && this.options.testing?.proxyLoopback !== true)
            return this.options.directFetch(input, init);
        const decision = this.resolve(host);
        if (decision.kind === 'blocked') {
            const message = `Egress blocked the request to ${host}: ${decision.reason}. No direct connection was attempted.`;
            this.record({ host, exit: decision.exitId, exitName: decision.exitId, ok: false, error: decision.reason.slice(0, 160) });
            throw new EgressError(message, decision.exitId);
        }
        if (decision.kind === 'direct') {
            try {
                const response = await this.options.directFetch(input, init);
                this.record({ host, exit: DIRECT_ID, exitName: 'direct', ok: true });
                return response;
            }
            catch (error) {
                if (!isAbort(error, init?.signal))
                    this.record({ host, exit: DIRECT_ID, exitName: 'direct', ok: false, error: describeError(error) });
                throw error;
            }
        }
        const { exit } = decision;
        const secrets = exit.auth === undefined ? [] : [exit.auth.username, exit.auth.password];
        try {
            const response = await this.viaProxy(exit, url, input, init);
            this.record({ host, exit: exit.id, exitName: exit.name, ok: true });
            return response;
        }
        catch (error) {
            const signal = init?.signal ?? (isRequestLike(input) ? input.signal : undefined);
            if (isAbort(error, signal))
                throw error;
            const detail = describeError(error, secrets);
            this.record({ host, exit: exit.id, exitName: exit.name, ok: false, error: detail });
            throw new EgressError(`Egress "${exit.name}" (${exit.type} ${hostPort(exit.host, exit.port)}) could not carry the connection to ${host}: ${detail}. `
                + 'The request was stopped and was not retried directly.', exit.id);
        }
    }
    /** Send one request through a proxy exit with undici's own fetch. */
    async viaProxy(exit, url, input, init) {
        const dispatcher = this.dispatcherFor(exit);
        const undici = this.tryUndici();
        if (undici === undefined)
            throw new Error('undici is not available');
        const options = { dispatcher };
        if (isRequestLike(input)) {
            options['method'] = input.method;
            options['headers'] = [...new Headers(input.headers).entries()];
            options['redirect'] = input.redirect;
            if (input.signal)
                options['signal'] = input.signal;
            if (input.method !== 'GET' && input.method !== 'HEAD')
                options['body'] = Buffer.from(await input.arrayBuffer());
        }
        if (init !== undefined) {
            const { headers, ...rest } = init;
            Object.assign(options, rest);
            if (headers !== undefined)
                options['headers'] = [...new Headers(headers).entries()];
            if (typeof init.body?.getReader === 'function')
                options['duplex'] = 'half';
        }
        return undici.module.fetch(url.href, options);
    }
    /**
     * Probe one exit: one GET of the fixed endpoint through it.
     * @param id - `direct` or a stored exit id.
     * @returns the stored probe record.
     * @throws {ValidationError} `not-found` when the id is unknown.
     */
    async probe(id) {
        const config = this.options.store.snapshot().config;
        const exit = id === DIRECT_ID ? undefined : config.exits.find(candidate => candidate.id === id);
        if (id !== DIRECT_ID && exit === undefined)
            throw new ValidationError('not-found', `no exit "${id}"`);
        const secrets = exit?.auth === undefined ? [] : [exit.auth.username, exit.auth.password];
        const started = Date.now();
        const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
        let record;
        try {
            const url = new URL(this.probeUrl);
            const response = exit === undefined
                ? await this.options.directFetch(url.href, { signal, headers: { accept: 'text/plain' } })
                : await this.viaProxy(exit, url, url.href, { signal, headers: { accept: 'text/plain' } });
            const text = (await response.text()).trim().slice(0, 100);
            const ms = Date.now() - started;
            if (!response.ok)
                record = { ok: false, ms, error: `HTTP ${String(response.status)} from the probe endpoint`, at: new Date().toISOString() };
            else if (isIP(text) === 0)
                record = { ok: false, ms, error: 'the probe endpoint did not answer with an IP address', at: new Date().toISOString() };
            else
                record = { ok: true, ip: text, ms, at: new Date().toISOString() };
        }
        catch (error) {
            const detail = describeError(error, secrets);
            record = { ok: false, ms: Date.now() - started, error: detail === 'timeout' || /timeout/.test(detail) ? `timeout after ${String(PROBE_TIMEOUT_MS / 1000)}s` : detail, at: new Date().toISOString() };
        }
        await this.options.store.mutate((draft) => {
            if (id === DIRECT_ID || draft.exits.some(candidate => candidate.id === id))
                draft.probes[id] = record;
        }).catch(() => undefined);
        return record;
    }
}
/** Key under which the installed hook is shared across plugin reloads. */
const HOLDER = Symbol.for('dsh-egress.holder');
/**
 * Install the hook on `globalThis.fetch`.
 *
 * Idempotent across plugin reloads: when our function is already installed, only
 * the runtime behind it is replaced, so the chain never grows and the original
 * fetch is never lost. The hook is deliberately never removed on dispose: a
 * deactivated plugin that restored the original fetch would silently turn every
 * proxied host into a direct connection.
 * @param make - builds the runtime from the fetch `direct` must use.
 * @returns the handle.
 */
export function installHook(make) {
    const scope = globalThis;
    const prior = scope[HOLDER];
    if (prior !== undefined && scope.fetch === prior.fn) {
        const runtime = make(prior.original);
        prior.runtime.dispose();
        prior.runtime = runtime;
        return { runtime, isActive: () => scope.fetch === prior.fn };
    }
    const original = scope.fetch;
    const runtime = make(original);
    const holder = {
        original,
        runtime,
        fn: function egressFetch(input, init) {
            return holder.runtime.fetch(input, init);
        },
    };
    scope.fetch = holder.fn;
    scope[HOLDER] = holder;
    return { runtime, isActive: () => scope.fetch === holder.fn };
}
