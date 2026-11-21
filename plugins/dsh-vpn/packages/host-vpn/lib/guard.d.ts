/**
 * The "never take the machine off the network" checks.
 *
 * The tunnel is only allowed to own the targets the user listed. Before any
 * route is added, each target is compared with the addresses this server needs
 * to stay reachable (its default gateway, its own address, loopback, the
 * watchdog's public probe, the VPN gateway itself). A target that would win the
 * longest-prefix match for one of them is refused.
 *
 * @module host-vpn/guard
 */
import type { V4Net } from './cidr.ts';
/** One line of `ip -4 route show`, reduced to what the guard reads. */
export interface RouteEntry {
    readonly isDefault: boolean;
    readonly net: V4Net | undefined;
    readonly via: string | undefined;
    readonly dev: string | undefined;
    readonly src: string | undefined;
}
/**
 * Parse `ip -4 route show` output.
 * @param text - command output.
 * @returns one entry per recognised line.
 */
export declare function parseRouteTable(text: string): RouteEntry[];
/**
 * A comparable key for the default route: its gateway and device.
 *
 * DHCP renewals change `metric` and `proto` without moving traffic, so only
 * `via` and `dev` are compared.
 * @param text - `ip -4 route show default` output.
 * @returns e.g. `via 198.18.31.253 dev eth0`, or an empty string when there is no default route.
 */
export declare function defaultRouteKey(text: string): string;
/** An address the server must keep reaching, with a human label. */
export interface ProtectedAddress {
    readonly label: string;
    readonly address: string;
}
/**
 * Work out which addresses must stay on their current path.
 * @param table - parsed main routing table.
 * @param extra - other addresses to protect (probe target, VPN gateway).
 * @returns the default gateway, the server's source address, loopback, and `extra`.
 */
export declare function protectedAddresses(table: readonly RouteEntry[], extra: readonly ProtectedAddress[]): ProtectedAddress[];
/**
 * Check IPv4 targets against the protected addresses.
 *
 * A target is refused when it contains a protected address and is at least as
 * specific as the best route that already carries that address. A broader
 * target is harmless: the existing, more specific route keeps winning.
 * @param table - parsed main routing table.
 * @param targets - IPv4 networks that would be routed into the tunnel.
 * @param protect - addresses that must stay reachable.
 * @returns an error message, or undefined when every target is safe.
 */
export declare function checkTargets(table: readonly RouteEntry[], targets: readonly V4Net[], protect: readonly ProtectedAddress[]): string | undefined;
/** Parse a list of validated IPv4 target strings into networks (non-IPv4 entries are skipped). */
export declare function v4Targets(values: readonly string[]): V4Net[];
/** Whether `inner` is already covered by one of `nets` (used to drop redundant host routes). */
export declare function covered(inner: V4Net, nets: readonly V4Net[]): boolean;
