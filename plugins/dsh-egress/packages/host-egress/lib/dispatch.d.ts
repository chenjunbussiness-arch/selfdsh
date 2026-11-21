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
import type { ProbeRecord, StoredExit } from './store.ts';
import { EgressStore } from './store.ts';
/** The only endpoint a probe ever contacts. Fixed in code, never user-supplied. */
export declare const PROBE_URL = "https://ifconfig.me/ip";
/** Probe timeout in milliseconds. */
export declare const PROBE_TIMEOUT_MS = 8000;
/** Size of the recent-requests ring. */
export declare const RING_SIZE = 100;
/** Why a request did not leave. Carries the exit so the message can name it. */
export declare class EgressError extends Error {
    readonly exitId: string;
    constructor(message: string, exitId: string, options?: {
        readonly cause?: unknown;
    });
}
/** The part of undici this module uses. */
export interface UndiciLike {
    fetch(input: string, init?: Record<string, unknown>): Promise<Response>;
    ProxyAgent: new (options: Record<string, unknown>) => DispatcherLike;
    Socks5ProxyAgent?: new (url: string, options: Record<string, unknown>) => DispatcherLike;
}
/** What an undici dispatcher offers that we call. */
export interface DispatcherLike {
    close(): Promise<void>;
}
/** A loaded undici and where it came from. */
export interface LoadedUndici {
    readonly module: UndiciLike;
    readonly source: string;
    readonly version?: string;
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
export declare function loadUndici(explicit?: string): LoadedUndici;
/** One line of the recent-requests ring. */
export interface RingEntry {
    readonly at: string;
    /** Target host (no port); never a path, header or body. */
    readonly host: string;
    readonly exit: string;
    readonly exitName: string;
    readonly ok: boolean;
    readonly error?: string;
}
/** The decision for one host. */
export type Resolution = {
    readonly kind: 'direct';
} | {
    readonly kind: 'proxy';
    readonly exit: StoredExit;
} | {
    readonly kind: 'blocked';
    readonly exitId: string;
    readonly reason: string;
};
/** Runtime construction options. */
export interface RuntimeOptions {
    readonly store: EgressStore;
    /** The fetch that was installed before the hook: what `direct` uses. */
    readonly directFetch: typeof fetch;
    /** Lazy undici loader; defaults to {@link loadUndici}. */
    readonly loadUndici?: () => LoadedUndici;
    readonly undiciPath?: string;
    /** Host → provider label, for display only. */
    readonly providers?: ReadonlyMap<string, string>;
    /** Test seams; the plugin never sets these. */
    readonly testing?: {
        /** Route loopback targets through the exit too (default: loopback passes straight through). */
        readonly proxyLoopback?: boolean;
        /** TLS options for the target connection (e.g. a test CA). */
        readonly requestTls?: Record<string, unknown>;
        /** Replace the probe endpoint. */
        readonly probeUrl?: string;
    };
}
/**
 * Describe a failure in one short, secret-free line.
 * @param error - thrown value.
 * @param secrets - literal values to mask.
 * @returns text such as `ECONNREFUSED connect ECONNREFUSED 127.0.0.1:9`.
 */
export declare function describeError(error: unknown, secrets?: readonly string[]): string;
/** Decides, sends and records. One instance per plugin activation. */
export declare class EgressRuntime {
    private readonly options;
    private undici;
    private undiciError;
    private readonly dispatchers;
    private readonly ring;
    private readonly seen;
    constructor(options: RuntimeOptions);
    /** The store behind this runtime. */
    get store(): EgressStore;
    /** Provider labels by host. */
    get providers(): ReadonlyMap<string, string>;
    /** The probe endpoint in force. */
    get probeUrl(): string;
    /** Newest first. */
    recent(): readonly RingEntry[];
    /** Hosts seen on the wire, newest first, with their last-seen time. */
    seenHosts(): readonly {
        readonly host: string;
        readonly at: string;
    }[];
    /** What loading undici did: ok/version/error. Loads lazily on first call. */
    undiciStatus(): {
        readonly ok: boolean;
        readonly version?: string;
        readonly source?: string;
        readonly error?: string;
    };
    /** Close every cached dispatcher. */
    dispose(): void;
    /**
     * Pick the exit for one host.
     * @param host - target host name, lower-case.
     * @returns direct, a proxy exit, or blocked with the reason.
     */
    resolve(host: string): Resolution;
    /** Load undici once; remember the failure so every request reports it the same way. */
    private tryUndici;
    /** Build or reuse the dispatcher of one exit; a changed exit gets a new one. */
    private dispatcherFor;
    /** Forget the dispatcher of a deleted exit. */
    forget(id: string): void;
    private record;
    /**
     * The replacement for `globalThis.fetch`.
     * @param input - URL, URL string or Request.
     * @param init - fetch options.
     * @returns the response.
     * @throws {EgressError} when the chosen exit cannot carry the request.
     */
    fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
    /** Send one request through a proxy exit with undici's own fetch. */
    private viaProxy;
    /**
     * Probe one exit: one GET of the fixed endpoint through it.
     * @param id - `direct` or a stored exit id.
     * @returns the stored probe record.
     * @throws {ValidationError} `not-found` when the id is unknown.
     */
    probe(id: string): Promise<ProbeRecord>;
}
/** What `installHook` reports. */
export interface HookHandle {
    readonly runtime: EgressRuntime;
    /** True while `globalThis.fetch` is still our function. */
    isActive(): boolean;
}
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
export declare function installHook(make: (original: typeof fetch) => EgressRuntime): HookHandle;
