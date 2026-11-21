/**
 * Small IPv4 network arithmetic, enough to reason about routes.
 *
 * Only IPv4 gets overlap checks. IPv6 targets are validated for shape and for a
 * minimum prefix length, but never compared (the server's own routes are IPv4).
 *
 * @module host-vpn/cidr
 */
import { isIP } from 'node:net';
/** Smallest IPv4 prefix a target may have: `/8`. Anything wider is a default-route in disguise. */
export const MIN_V4_PREFIX = 8;
/** Smallest IPv6 prefix a target may have: `/16`. */
export const MIN_V6_PREFIX = 16;
/** Netmask of a prefix length, as an unsigned 32-bit integer. */
function maskOf(prefix) {
    return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}
/**
 * Convert a dotted quad to an unsigned integer.
 * @param text - candidate address.
 * @returns the integer, or undefined when `text` is not a plain IPv4 address.
 */
export function v4ToInt(text) {
    if (isIP(text) !== 4)
        return undefined;
    const parts = text.split('.').map(Number);
    return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}
/** Convert an unsigned integer back to a dotted quad. */
export function intToV4(value) {
    return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}
/**
 * Parse `a.b.c.d` or `a.b.c.d/len`.
 * @param text - candidate network.
 * @returns the masked network, or undefined when `text` is not an IPv4 network.
 */
export function parseV4Net(text) {
    const slash = text.indexOf('/');
    const addr = slash < 0 ? text : text.slice(0, slash);
    const lenText = slash < 0 ? '32' : text.slice(slash + 1);
    if (!/^\d{1,2}$/.test(lenText))
        return undefined;
    const prefix = Number(lenText);
    if (prefix > 32)
        return undefined;
    const value = v4ToInt(addr);
    if (value === undefined)
        return undefined;
    return { base: (value & maskOf(prefix)) >>> 0, prefix };
}
/** Canonical `a.b.c.d/len` text of a network. */
export function formatV4Net(net) {
    return `${intToV4(net.base)}/${String(net.prefix)}`;
}
/** Whether `outer` contains every address of `inner`. */
export function v4NetContains(outer, inner) {
    return outer.prefix <= inner.prefix && ((inner.base & maskOf(outer.prefix)) >>> 0) === outer.base;
}
/** Whether `net` contains the address `value`. */
export function v4NetHas(net, value) {
    return ((value & maskOf(net.prefix)) >>> 0) === net.base;
}
