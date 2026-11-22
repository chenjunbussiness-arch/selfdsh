/**
 * Login check for the HTTP bridge.
 *
 * `dsh-client-connection` checks the login cookie on its `/api` prefix route.
 * A plugin route such as `/api/<plugin>/state` is a longer prefix, so the web
 * server picks it first and the connection's check never runs. Without this
 * wrapper anyone who can reach the port (or a worker's shell on the same
 * machine) could read or change this plugin's state with no login.
 */
/**
 * Wrap a route so it answers only a logged-in browser.
 * @param route - the bridge route.
 * @param connection - reads the `connection` service at request time (it may start later).
 * @returns the guarded route; 401/403 from the connection, 503 when no connection service is up.
 */
export function requireLogin(route, connection) {
    return {
        ...route,
        handler: async (req, res) => {
            const check = connection();
            const rejection = typeof check?.requestRejection === 'function' ? check.requestRejection(req) : 503;
            if (rejection !== undefined) {
                res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
                res.end(rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'login service unavailable');
                return;
            }
            await route.handler(req, res);
        },
    };
}
