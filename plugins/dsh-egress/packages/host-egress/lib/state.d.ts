/**
 * The redacted state document served to the panel and to the status tool.
 *
 * Nothing in here can carry a credential: an exit exposes `hasAuth` and a URL
 * whose userinfo is `***:***`, and there is no field a password could travel in.
 *
 * @module host-egress/state
 */
import type { EgressRuntime, RingEntry } from './dispatch.ts';
import type { ProbeRecord, StoredExit } from './store.ts';
/** One exit as the panel sees it. */
export interface ExitView {
    readonly id: string;
    readonly name: string;
    readonly type: 'direct' | 'http' | 'https' | 'socks5';
    readonly builtin: boolean;
    readonly host?: string;
    readonly port?: number;
    readonly hasAuth: boolean;
    /** `type://[***:***@]host:port`, or `direct`. */
    readonly url: string;
    readonly lastProbe?: ProbeRecord;
}
/** One row of the binding table. */
export interface BindingView {
    /** Target host, or `*` for the default exit. */
    readonly host: string;
    /** Label of the model provider that uses this host, when known. */
    readonly provider?: string;
    /** Exit the host currently uses. */
    readonly exit: string;
    /** `binding` when set explicitly, `default` when it follows the default exit. */
    readonly source: 'binding' | 'default';
    readonly lastSeen?: string;
}
/** The whole document. */
export interface EgressState {
    readonly version: 1;
    readonly origin: 'host';
    readonly fetchedAt: string;
    readonly exits: readonly ExitView[];
    readonly defaultExit: string;
    readonly bindings: readonly BindingView[];
    /** How a change takes effect, and whether the hook is healthy. */
    readonly apply: {
        readonly mode: 'instant' | 'restart';
        readonly hookActive: boolean;
        readonly undici: {
            readonly ok: boolean;
            readonly version?: string;
            readonly error?: string;
        };
        /** Set when the config file is unusable and every non-loopback request is blocked. */
        readonly corrupt?: string;
        readonly restartHint: string;
    };
    readonly recent: readonly RingEntry[];
    readonly probeEndpoint: string;
}
/** Fixed restart hint shown when the mode is `restart`. The plugin never restarts anything itself. */
export declare const RESTART_HINT = "systemctl restart dsh-web";
/**
 * Turn a stored exit into its redacted view.
 * @param exit - stored exit.
 * @param probe - last probe, if any.
 * @returns the view.
 */
export declare function exitView(exit: StoredExit, probe: ProbeRecord | undefined): ExitView;
/**
 * Build the state document.
 * @param runtime - the live runtime.
 * @param hookActive - whether `globalThis.fetch` is still our function.
 * @param extraHosts - provider hosts from the plugin config, host → label.
 * @returns the document.
 */
export declare function buildState(runtime: EgressRuntime, hookActive: boolean, extraHosts: ReadonlyMap<string, string>): EgressState;
/**
 * Collect `host → label` from the configured providers.
 * @param providers - plugin config providers.
 * @returns the map; entries whose URL is not http(s) are skipped.
 */
export declare function providerHosts(providers: readonly {
    readonly name: string;
    readonly baseURL: string;
}[] | undefined): Map<string, string>;
/**
 * One-paragraph status for the agent tool. Redacted by construction.
 * @param state - the state document.
 * @returns plain text.
 */
export declare function statusText(state: EgressState): string;
