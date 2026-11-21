/**
 * The exit store: exits, bindings, the default exit and last probe results.
 *
 * One JSON file (`config.json`, mode 0600, in a 0700 directory) holds
 * everything, proxy credentials included. The file is the source of truth and
 * the in-memory copy is reloaded whenever its mtime or size changes, so a hand
 * edit takes effect on the next request without a restart.
 *
 * A file that exists but cannot be parsed or validated is reported as
 * `corrupt`, and the request hook treats that as "block every non-loopback
 * request": an unreadable policy must never degrade into "connect directly".
 *
 * @module host-egress/store
 */
import type { ProxyType } from './validate.ts';
/** Credentials of one proxy. */
export interface ExitAuth {
    readonly username: string;
    readonly password: string;
}
/** One user-defined exit as stored. */
export interface StoredExit {
    readonly id: string;
    readonly name: string;
    readonly type: ProxyType;
    readonly host: string;
    readonly port: number;
    readonly auth?: ExitAuth;
    readonly createdAt: string;
}
/** The last probe of one exit. */
export interface ProbeRecord {
    readonly ok: boolean;
    readonly ip?: string;
    readonly ms?: number;
    readonly error?: string;
    readonly at: string;
}
/** The whole persisted document. */
export interface StoredConfig {
    readonly version: 1;
    readonly exits: readonly StoredExit[];
    /** Host (lower-case, no port) → exit id. `*` is never stored here; see `defaultExit`. */
    readonly bindings: Readonly<Record<string, string>>;
    /** Exit for hosts without a binding. Starts as `direct`. */
    readonly defaultExit: string;
    readonly probes: Readonly<Record<string, ProbeRecord>>;
}
/** A fresh document: no exits, everything direct. */
export declare const EMPTY_CONFIG: StoredConfig;
/** What `snapshot()` returns. */
export interface StoreSnapshot {
    readonly config: StoredConfig;
    /** Set when the file exists but is unusable. */
    readonly corrupt?: string;
}
/**
 * Validate a decoded document, rebuilding it from validated parts.
 * @param raw - parsed JSON.
 * @returns the clean document.
 * @throws {ValidationError} when anything is off.
 */
export declare function parseConfig(raw: unknown): StoredConfig;
/** Mutable working copy handed to `mutate`. */
export interface Draft {
    exits: StoredExit[];
    bindings: Record<string, string>;
    defaultExit: string;
    probes: Record<string, ProbeRecord>;
}
/** File-backed store. */
export declare class EgressStore {
    readonly dir: string;
    private cached;
    private stamp;
    private queue;
    /** @param dir - data directory; created 0700 on the first write. */
    constructor(dir: string);
    /** Absolute path of the document. */
    get file(): string;
    /**
     * Current state, reloading when the file changed on disk.
     * @returns the config, or `corrupt` when the file is unusable.
     */
    snapshot(): StoreSnapshot;
    /**
     * Apply one change and persist it atomically.
     *
     * Changes are serialised. A corrupt file is moved aside to
     * `config.json.corrupt-<time>` before the first write over it.
     * @param change - edits the draft; may throw {@link ValidationError} to abort.
     * @returns the new config.
     */
    mutate(change: (draft: Draft) => void): Promise<StoredConfig>;
    /** Write the document: tmp file, then rename with a retry for Windows EPERM/EBUSY. */
    private write;
    /** Create the directory with the right mode (idempotent). */
    ensureDir(): void;
}
