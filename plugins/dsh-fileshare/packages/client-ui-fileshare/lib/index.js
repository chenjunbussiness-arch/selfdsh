/**
 * Node (Host) half of the package.
 *
 * The 文件中转 page is a Client-only contribution: it renders what
 * `dsh-host-fileshare` serves under `/api/fileshare`. This half exists because
 * the profile loads a package through its Host entry before the Web shell
 * mounts its `dsh.client` half; a package without one cannot be activated.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'client-ui-fileshare'

/** No Host services are required: this half contributes nothing. */
export const inject = []

/** Intentionally empty: everything this package ships is browser-side. */
export function apply() {}
