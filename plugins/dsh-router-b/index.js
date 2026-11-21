/**
 * Host entry of the `dsh-router-b` bundle.
 *
 * A bundle is a patch layer, not a plugin: `dsh.bundle.patch` in this package's
 * `package.json` is what puts the two real rows into the profile
 * (`cordis.patch.yml` → `dsh-host-router` and `dsh-client-ui-router`). This file
 * exists because a bundle package is also a package the loader can mount, and
 * the manifest rules expect a `.` export; it contributes nothing and requires
 * nothing.
 *
 * Keeping the export real (rather than omitting it) means the row is a normal
 * Cordis plugin that can be enabled, disabled, and reloaded like any other.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'dsh-router-b'

/** No services are required: this half contributes nothing. */
export const inject = []

/**
 * Activate the bundle's own row.
 *
 * Intentionally empty: the work happens in the two rows the patch mounts.
 */
export function apply() {}
