/**
 * Host entry of the `dsh-vpn` bundle.
 *
 * A bundle is a patch layer, not a plugin: `dsh.bundle.patch` in this package's
 * `package.json` puts the two real rows into the profile (`cordis.patch.yml` →
 * `dsh-host-vpn` and `dsh-client-ui-vpn`). This file exists because the manifest
 * rules expect a `.` export; it contributes nothing and requires nothing.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'dsh-vpn'

/** No services are required: this half contributes nothing. */
export const inject = []

/** Intentionally empty: the work happens in the two rows the patch mounts. */
export function apply() {}
