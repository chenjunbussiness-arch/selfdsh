/**
 * Host entry of the `dsh-fileshare` bundle.
 *
 * A bundle is a patch layer, not a plugin: `dsh.bundle.patch` in package.json
 * mounts the real rows (`cordis.patch.yml` → `dsh-host-fileshare` and
 * `dsh-client-ui-fileshare`). This file exists because the manifest rules
 * expect a `.` export; it contributes nothing.
 */

export const name = 'dsh-fileshare'
export const inject = []
export function apply() {}
