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

import { MIN_V4_PREFIX, formatV4Net, parseV4Net, v4NetContains, v4NetHas, v4ToInt } from './cidr.ts'
import type { V4Net } from './cidr.ts'

/** One line of `ip -4 route show`, reduced to what the guard reads. */
export interface RouteEntry {
  readonly isDefault: boolean
  readonly net: V4Net | undefined
  readonly via: string | undefined
  readonly dev: string | undefined
  readonly src: string | undefined
}

/**
 * Parse `ip -4 route show` output.
 * @param text - command output.
 * @returns one entry per recognised line.
 */
export function parseRouteTable(text: string): RouteEntry[] {
  const out: RouteEntry[] = []
  for (const line of text.split('\n')) {
    const words = line.trim().split(/\s+/)
    const first = words[0]
    if (first === undefined || first === '') continue
    const after = (key: string): string | undefined => {
      const at = words.indexOf(key)
      return at >= 0 ? words[at + 1] : undefined
    }
    const isDefault = first === 'default'
    out.push({
      isDefault,
      net: isDefault ? undefined : parseV4Net(first),
      via: after('via'),
      dev: after('dev'),
      src: after('src'),
    })
  }
  return out
}

/**
 * A comparable key for the default route: its gateway and device.
 *
 * DHCP renewals change `metric` and `proto` without moving traffic, so only
 * `via` and `dev` are compared.
 * @param text - `ip -4 route show default` output.
 * @returns e.g. `via 192.0.2.30 dev eth0`, or an empty string when there is no default route.
 */
export function defaultRouteKey(text: string): string {
  const entry = parseRouteTable(text).find(route => route.isDefault)
  if (entry === undefined) return ''
  return `via ${entry.via ?? '-'} dev ${entry.dev ?? '-'}`
}

/** An address the server must keep reaching, with a human label. */
export interface ProtectedAddress {
  readonly label: string
  readonly address: string
}

/**
 * Work out which addresses must stay on their current path.
 * @param table - parsed main routing table.
 * @param extra - other addresses to protect (probe target, VPN gateway).
 * @returns the default gateway, the server's source address, loopback, and `extra`.
 */
export function protectedAddresses(table: readonly RouteEntry[], extra: readonly ProtectedAddress[]): ProtectedAddress[] {
  const out: ProtectedAddress[] = [{ label: 'loopback', address: '127.0.0.1' }]
  const def = table.find(route => route.isDefault)
  if (def?.via !== undefined) out.push({ label: 'the default gateway', address: def.via })
  if (def?.src !== undefined) out.push({ label: 'this server\'s own address', address: def.src })
  return [...out, ...extra]
}

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
export function checkTargets(
  table: readonly RouteEntry[],
  targets: readonly V4Net[],
  protect: readonly ProtectedAddress[],
): string | undefined {
  for (const entry of protect) {
    const value = v4ToInt(entry.address)
    if (value === undefined) continue
    let best = 0
    for (const route of table) {
      if (route.isDefault || route.net === undefined) continue
      if (v4NetHas(route.net, value) && route.net.prefix > best) best = route.net.prefix
    }
    for (const target of targets) {
      if (target.prefix < MIN_V4_PREFIX) return `target ${formatV4Net(target)} is too wide`
      if (v4NetHas(target, value) && target.prefix >= best) {
        return `target ${formatV4Net(target)} would capture ${entry.label} (${entry.address}); the server would lose its normal path`
      }
    }
  }
  return undefined
}

/** Parse a list of validated IPv4 target strings into networks (non-IPv4 entries are skipped). */
export function v4Targets(values: readonly string[]): V4Net[] {
  return values.map(parseV4Net).filter((net): net is V4Net => net !== undefined)
}

/** Whether `inner` is already covered by one of `nets` (used to drop redundant host routes). */
export function covered(inner: V4Net, nets: readonly V4Net[]): boolean {
  return nets.some(net => v4NetContains(net, inner))
}
