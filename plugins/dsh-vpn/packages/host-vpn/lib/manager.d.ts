/**
 * The connection manager: one openfortivpn child, a state machine, a log ring,
 * split-tunnel routes, and the watchdog.
 *
 * Why a plain child process and not a systemd transient unit: the child is
 * bound to this plugin. If the plugin is disposed the tunnel is torn down with
 * it, and `run.json` lets the next start find and kill a child that outlived a
 * hard crash. A transient unit would keep the tunnel alive after DSH is gone,
 * which is the opposite of what this plugin wants for a tunnel that can cut off
 * the server's own access.
 *
 * State machine:
 *
 *   disconnected ──connect──▶ connecting ──ready+routes+watchdog window──▶ connected
 *        ▲                        │                                          │
 *        │                        └────────── error / timeout ──▶ failed ◀───┘ (process died, watchdog tripped)
 *        └────────────── disconnect (from any state) ───────────────────────┘
 *
 * @module host-vpn/manager
 */
import { spawn as nodeSpawn } from 'node:child_process';
import type { CookieFetcher } from './forti.ts';
import type { ProfileStore } from './store.ts';
import type { LoggerService } from './types.ts';
/** Connection states. */
export type VpnStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';
/** Watchdog states. */
export type WatchdogState = 'idle' | 'watching' | 'passed' | 'tripped';
/** One log line. */
export interface LogLine {
    readonly t: string;
    readonly level: 'info' | 'warn' | 'error' | 'out';
    readonly text: string;
}
/** What is known about the openfortivpn binary. */
export interface InstallInfo {
    readonly installed: boolean;
    readonly version: string;
    readonly cookieSupport: boolean;
    readonly pppd: boolean;
    readonly hint: string;
}
/** The document `GET /api/vpn/status` answers with. Holds no secret. */
export interface StatusDocument {
    readonly status: VpnStatus;
    readonly profileId: string | undefined;
    readonly profileName: string | undefined;
    readonly iface: string | undefined;
    readonly ip: string | undefined;
    readonly connectedAt: string | undefined;
    readonly uptimeSeconds: number | undefined;
    readonly error: string | undefined;
    readonly pid: number | undefined;
    readonly routes: readonly string[];
    readonly watchdog: {
        readonly state: WatchdogState;
        readonly secondsLeft: number | undefined;
        readonly reason: string | undefined;
    };
    readonly install: InstallInfo;
    readonly updatedAt: string;
}
/** Result of an external command. */
export interface ExecResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}
/** Everything the manager touches outside itself, injectable for tests. */
export interface ManagerOptions {
    readonly store: ProfileStore;
    /** Private directory for `run.json` and temporary config files. */
    readonly dir: string;
    /** openfortivpn executable plus fixed leading arguments. */
    readonly exe: readonly string[];
    readonly logger: LoggerService;
    readonly allowCustom: boolean;
    readonly watchdogMs: number;
    readonly watchdogIntervalMs: number;
    readonly guardIntervalMs: number;
    readonly connectTimeoutMs: number;
    readonly killGraceMs: number;
    /** Port of the local DSH web service the watchdog must still reach; 0 disables the check. */
    readonly localProbePort: number;
    /** `host:port` that must stay reachable over the normal route; empty disables the check. */
    readonly publicProbe: string;
    readonly spawn?: typeof nodeSpawn;
    readonly exec?: (argv: readonly string[]) => Promise<ExecResult>;
    readonly tcp?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
    readonly lookupAll?: (host: string) => Promise<string[]>;
    readonly cookie?: CookieFetcher;
    readonly detect?: () => Promise<InstallInfo>;
    readonly readCmdline?: (pid: number) => Promise<string | undefined>;
    readonly isAlive?: (pid: number) => boolean;
    readonly env?: Readonly<Record<string, string>>;
    readonly now?: () => number;
}
/** Thrown for a request that is invalid in the current state. */
export declare class ConflictError extends Error {
    constructor(message: string);
}
/** Ring buffer size. */
export declare const LOG_LINES = 200;
/** The manager. */
export declare class VpnManager {
    private readonly o;
    private status;
    private profile;
    private iface;
    private ip;
    private connectedAt;
    private error;
    private routes;
    private watchState;
    private watchUntil;
    private watchReason;
    private child;
    private exited;
    private stopping;
    private generation;
    private readonly timers;
    private readonly logs;
    private secrets;
    private installCache;
    private tempConfig;
    constructor(o: ManagerOptions);
    private now;
    private exec;
    private log;
    /** The newest log lines, already redacted. */
    logLines(limit?: number): LogLine[];
    /** Detect the openfortivpn binary (cached for a minute). */
    install(force?: boolean): Promise<InstallInfo>;
    /** Current state, without secrets. */
    statusDocument(): Promise<StatusDocument>;
    /** Current status string only. */
    get state(): VpnStatus;
    /**
     * Start connecting a profile. Resolves once the child is started (or the
     * attempt has already failed); the state moves on in the background.
     * @param id - profile id.
     * @returns the state right after the request.
     * @throws {ConflictError} when a connection is already starting or up.
     */
    connect(id: string): Promise<StatusDocument>;
    /** Everything before the child is running; throws a message-only Error to fail the attempt. */
    private start;
    /** A string that identifies our child in `/proc/<pid>/cmdline`. */
    private marker;
    private probeTarget;
    private gatewayAddresses;
    /** Turn host-name targets into addresses now, before the tunnel can change what the resolver answers. */
    private resolveTargets;
    private pipeLines;
    /** The tunnel is up: add only the user's routes, then watch. */
    private onReady;
    private addRoute;
    private startWatchdog;
    private trip;
    private after;
    private clearTimers;
    /** Record a failure and take the tunnel down. */
    private fail;
    private killChild;
    private onExit;
    private cleanupFiles;
    /**
     * Stop the tunnel.
     * @returns the state afterwards.
     */
    disconnect(): Promise<StatusDocument>;
    /** Stop everything when the plugin is disposed: a tunnel never outlives its owner. */
    dispose(): Promise<void>;
    /**
     * Kill an openfortivpn left over from a previous run.
     *
     * It is cleaned up, not adopted: the new process has lost the child's pipes
     * (no logs, no stdin) and the watchdog context, so a tunnel it cannot watch
     * is not a tunnel it should keep.
     * @returns what was done, for the log.
     */
    recover(): Promise<string>;
}
