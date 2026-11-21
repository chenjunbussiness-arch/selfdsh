/**
 * The panel's data contract: the redacted state document of the host bridge
 * (`GET /api/egress/state`, `packages/host-egress/src/state.ts`) and the source
 * the panel reads and writes through.
 *
 * Kept in lockstep with the host by hand: the host package imports no client
 * module and this one imports no host module. Nothing here can carry a proxy
 * credential: an exit has `hasAuth` and a masked URL, and the only place a
 * password exists in the browser is the form field while it is being typed.
 */
/** Exit kinds. */
export type ExitType = 'direct' | 'http' | 'https' | 'socks5';
/** The last probe of one exit. */
export interface ProbeResult {
    readonly ok: boolean;
    readonly ip?: string;
    readonly ms?: number;
    readonly error?: string;
    readonly at: string;
}
/** One exit. */
export interface ExitView {
    readonly id: string;
    readonly name: string;
    readonly type: ExitType;
    readonly builtin: boolean;
    readonly host?: string;
    readonly port?: number;
    readonly hasAuth: boolean;
    /** `type://[***:***@]host:port`, or `direct`. */
    readonly url: string;
    readonly lastProbe?: ProbeResult;
}
/** One row of the binding table. */
export interface BindingView {
    readonly host: string;
    readonly provider?: string;
    readonly exit: string;
    readonly source: 'binding' | 'default';
    readonly lastSeen?: string;
}
/** One line of the recent-requests ring. */
export interface RingEntry {
    readonly at: string;
    readonly host: string;
    readonly exit: string;
    readonly exitName: string;
    readonly ok: boolean;
    readonly error?: string;
}
/** The whole document. */
export interface EgressState {
    readonly version: 1;
    readonly origin: 'host' | 'mock';
    readonly fetchedAt: string;
    readonly exits: readonly ExitView[];
    readonly defaultExit: string;
    readonly bindings: readonly BindingView[];
    readonly apply: {
        readonly mode: 'instant' | 'restart';
        readonly hookActive: boolean;
        readonly undici: {
            readonly ok: boolean;
            readonly version?: string;
            readonly error?: string;
        };
        readonly corrupt?: string;
        readonly restartHint: string;
    };
    readonly recent: readonly RingEntry[];
    readonly probeEndpoint: string;
}
/** What the form submits. A blank `password` keeps the stored one on edit. */
export interface ExitInput {
    readonly id?: string;
    readonly name: string;
    readonly type: Exclude<ExitType, 'direct'>;
    readonly host: string;
    readonly port: number;
    readonly username?: string;
    readonly password?: string;
    readonly clearAuth?: boolean;
}
/** Where the panel gets its data and sends its changes. */
export interface EgressSource {
    /** `host` for the real bridge, `mock` for sample data. */
    readonly origin: 'host' | 'mock';
    load(): Promise<EgressState>;
    putExit(input: ExitInput): Promise<EgressState>;
    deleteExit(id: string): Promise<EgressState>;
    /** `exit: null` removes a binding; host `*` sets the default exit. */
    putBinding(host: string, exit: string | null): Promise<EgressState>;
    probe(id: string): Promise<{
        readonly result: ProbeResult;
        readonly state: EgressState;
    }>;
}
/** Namespace-bound translate. */
export type Translate = (key: string, values?: Record<string, string | number>) => string;
