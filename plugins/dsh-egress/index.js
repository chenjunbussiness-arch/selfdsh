/**
 * Host entry of the `dsh-egress` bundle.
 *
 * A bundle is a patch layer: `dsh.bundle.patch` in this package's `package.json`
 * puts the two real rows into the profile (`cordis.patch.yml` → `dsh-host-egress`
 * and `dsh-client-ui-egress`). This file exists because the loader expects a `.`
 * export; it contributes nothing and requires nothing.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'dsh-egress'

/** No services are required: this half contributes nothing. */
export const inject = []

/** Intentionally empty: the work happens in the two rows the patch mounts. */
export function apply() {}