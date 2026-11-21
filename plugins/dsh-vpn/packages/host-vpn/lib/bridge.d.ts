/**
 * The HTTP bridge between the VPN manager and the Web page.
 *
 *   GET    /api/vpn/status                 state, install info, watchdog
 *   GET    /api/vpn/profiles               profiles without any secret
 *   PUT    /api/vpn/profile                create (no id) or update (id) one profile
 *   DELETE /api/vpn/profile?id=<id>        delete a profile and its secret
 *   POST   /api/vpn/connect   {id}         start connecting (only a person does this)
 *   POST   /api/vpn/disconnect             stop the tunnel
 *   GET    /api/vpn/logs?limit=<n>         newest redacted log lines
 *
 * Trust model: the routes are served by the Harness web server behind nginx
 * Basic auth. On top of that, every write requires `application/json` (a browser
 * must preflight a cross-origin request) and, when the browser sends an `Origin`
 * header, that origin's host must be the host the request was addressed to.
 *
 * No response carries a secret: profiles expose `secretConfigured` only, and
 * log lines are redacted when they are written.
 *
 * @module host-vpn/bridge
 */
import type { VpnManager } from './manager.ts';
import type { ProfileStore } from './store.ts';
import type { LoggerService, WebRouteLike } from './types.ts';
/** Path prefix every route lives under. */
export declare const BRIDGE_BASE = "/api/vpn";
export declare const STATUS_PATH = "/api/vpn/status";
export declare const PROFILES_PATH = "/api/vpn/profiles";
export declare const PROFILE_PATH = "/api/vpn/profile";
export declare const CONNECT_PATH = "/api/vpn/connect";
export declare const DISCONNECT_PATH = "/api/vpn/disconnect";
export declare const LOGS_PATH = "/api/vpn/logs";
/** A failed call: HTTP status plus a stable code. */
export declare class BridgeError extends Error {
    readonly status: number;
    readonly code: string;
    readonly field?: string | undefined;
    constructor(status: number, code: string, message: string, field?: string | undefined);
}
/** What the routes act on. */
export interface BridgeDeps {
    readonly logger: LoggerService;
    readonly manager: VpnManager;
    readonly store: ProfileStore;
    readonly allowCustom: boolean;
}
/** Build the routes. Pure construction; registration belongs to the plugin. */
export declare function createRoutes(deps: BridgeDeps): readonly WebRouteLike[];
