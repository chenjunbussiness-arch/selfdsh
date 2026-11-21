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
import type { EgressRuntime } from './dispatch.ts';
import type { LoggerService, WebRouteLike } from './types.ts';
/** Path prefix every route lives under. */
export declare const BRIDGE_BASE = "/api/egress";
/** `GET`. */
export declare const STATE_PATH = "/api/egress/state";
/** `PUT` / `DELETE`. */
export declare const EXIT_PATH = "/api/egress/exit";
/** `PUT`. */
export declare const BINDING_PATH = "/api/egress/binding";
/** `POST`. */
export declare const PROBE_PATH = "/api/egress/probe";
/** Most exits one profile may hold; a sanity bound, not a product limit. */
export declare const MAX_EXITS = 200;
/** A failed call: status plus the stable code the client prints. */
export declare class BridgeError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string);
}
/** What the routes need. */
export interface BridgeDeps {
    readonly logger: LoggerService;
    readonly runtime: EgressRuntime;
    readonly hookActive: () => boolean;
    readonly providers: ReadonlyMap<string, string>;
}
/**
 * Build the bridge's routes.
 * @param deps - what the handlers act on.
 * @returns one route per endpoint.
 */
export declare function createRoutes(deps: BridgeDeps): readonly WebRouteLike[];
