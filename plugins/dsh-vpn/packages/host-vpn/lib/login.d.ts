/**
 * Login check for the HTTP bridge.
 *
 * `dsh-client-connection` checks the login cookie on its `/api` prefix route.
 * A plugin route such as `/api/<plugin>/state` is a longer prefix, so the web
 * server picks it first and the connection's check never runs. Without this
 * wrapper anyone who can reach the port (or a worker's shell on the same
 * machine) could read or change this plugin's state with no login.
 */
import type { IncomingMessage } from 'node:http';
import type { WebRouteLike } from './types.ts';
/** The part of the `connection` service this check uses. */
export interface LoginCheck {
    requestRejection?(request: IncomingMessage): number | undefined;
}
/**
 * Wrap a route so it answers only a logged-in browser.
 * @param route - the bridge route.
 * @param connection - reads the `connection` service at request time (it may start later).
 * @returns the guarded route; 401/403 from the connection, 503 when no connection service is up.
 */
export declare function requireLogin(route: WebRouteLike, connection: () => LoginCheck | undefined): WebRouteLike;
