/**
 * Node (Host) half of the package.
 *
 * The dispatch panel is a Client-only contribution: it renders what
 * `dsh-host-agent-hub` serves at `/api/agent-hub/admin/*` (login-guarded,
 * read-only). This half exists because the profile loads a package through its
 * Host entry before the Web shell mounts its `dsh.client` half; a package
 * without one cannot be activated.
 *
 * `lib/client.js` (the browser half) is NOT checked in: build it on the server
 * with `node scripts/build-client.mjs` (see the bundle README, "调度面板").
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'client-ui-agent-hub'

/** No Host services are required: this half contributes nothing. */
export const inject = []

/** Intentionally empty: everything this package ships is browser-side. */
export function apply() {}
