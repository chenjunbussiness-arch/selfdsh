/**
 * Host entry of the `dsh-agent-hub` bundle.
 *
 * A bundle is a patch layer: `cordis.patch.yml` mounts the real row
 * (`dsh-host-agent-hub`). This file exists because the manifest rules expect a
 * `.` export; it contributes nothing.
 */
export const name = 'dsh-agent-hub'
export const inject = []
export function apply() {}
