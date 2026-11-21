/**
 * Small IPv4 network arithmetic, enough to reason about routes.
 *
 * Only IPv4 gets overlap checks. IPv6 targets are validated for shape and for a
 * minimum prefix length, but never compared (the server's own routes are IPv4).
 *
 * @module host-vpn/cidr
 */
/** One IPv4 network. `base` is already masked. */
export interface V4Net {
    readonly base: number;
    readonly prefix: number;
}
/** Smallest IPv4 prefix a target may have: `/8`. Anything wider is a default-route in disguise. */
export declare const MIN_V4_PREFIX = 8;
/** Smallest IPv6 prefix a target may have: `/16`. */
export declare const MIN_V6_PREFIX = 16;
/**
 * Convert a dotted quad to an unsigned integer.
 * @param text - candidate address.
 * @returns the integer, or undefined when `text` is not a plain IPv4 address.
 */
export declare function v4ToInt(text: string): number | undefined;
/** Convert an unsigned integer back to a dotted quad. */
export declare function intToV4(value: number): string;
/**
 * Parse `a.b.c.d` or `a.b.c.d/len`.
 * @param text - candidate network.
 * @returns the masked network, or undefined when `text` is not an IPv4 network.
 */
export declare function parseV4Net(text: string): V4Net | undefined;
/** Canonical `a.b.c.d/len` text of a network. */
export declare function formatV4Net(net: V4Net): string;
/** Whether `outer` contains every address of `inner`. */
export declare function v4NetContains(outer: V4Net, inner: V4Net): boolean;
/** Whether `net` contains the address `value`. */
export declare function v4NetHas(net: V4Net, value: number): boolean;
