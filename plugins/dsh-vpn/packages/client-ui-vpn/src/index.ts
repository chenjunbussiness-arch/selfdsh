/**
 * Node (Host) half of the package.
 *
 * The VPN page is a Client-only contribution: it renders what `dsh-host-vpn`
 * serves over `/api/vpn/*`. This half exists because the profile loads a package
 * through its Host entry before the Web shell mounts its `dsh.client` half.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'client-ui-vpn'

/** No Host services are required: this half contributes nothing. */
export const inject: readonly string[] = []

/** Intentionally empty: everything this package ships is browser-side. */
export function apply(): void {}
