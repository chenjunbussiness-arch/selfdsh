/**
 * Host entry of the `dsh-secrets` bundle.
 *
 * A bundle is a patch layer, not a plugin: `dsh.bundle.patch` in package.json
 * mounts the real row (`cordis.patch.yml` → `dsh-host-secrets`). This file exists
 * because the manifest rules expect a `.` export; it contributes nothing.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'dsh-secrets'

/** No services are required: this half contributes nothing. */
export const inject = []

/** Intentionally empty: the work happens in the row the patch mounts. */
export function apply() {}
