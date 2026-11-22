/**
 * Node (Host) half of the package.
 *
 * The secrets dashboard is a Client-only contribution: it renders what
 * `dsh-host-secrets` serves at `/api/secrets/summary` and `/api/secrets/list`.
 * This half exists because the profile loads a package through its Host entry
 * before the Web shell mounts its `dsh.client` half; a package without one
 * cannot be activated.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'client-ui-secrets'

/** No Host services are required: this half contributes nothing. */
export const inject = []

/** Intentionally empty: everything this package ships is browser-side. */
export function apply() {}
