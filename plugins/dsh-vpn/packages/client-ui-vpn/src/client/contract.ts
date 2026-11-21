/**
 * Wire contract between the page and the host bridge (`/api/vpn/*`).
 *
 * Mirrors `packages/host-vpn/src/{manager,store,validate}.ts`. The two packages
 * are deployed together, so this file is the whole coupling. No field here can
 * hold a secret: a profile reports `secretConfigured` only.
 */

/** Connection state. */
export type VpnState = 'disconnected' | 'connecting' | 'connected' | 'failed'
/** Authentication kind. */
export type ProfileType = 'password' | 'token-url' | 'custom'
/** Watchdog state. */
export type WatchdogState = 'idle' | 'watching' | 'passed' | 'tripped'

/** One profile as the read endpoints return it. */
export interface ProfileView {
  readonly id: string
  readonly name: string
  readonly type: ProfileType
  readonly host: string
  readonly port: number
  readonly username: string
  readonly realm: string
  readonly trustedCert: string
  readonly targets: readonly string[]
  readonly setDns: boolean
  readonly command: readonly string[]
  readonly secretConfigured: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

/** What the host knows about the openfortivpn binary. */
export interface InstallView {
  readonly installed: boolean
  readonly version: string
  readonly cookieSupport: boolean
  readonly pppd: boolean
  readonly hint: string
}

/** `GET /api/vpn/status`. */
export interface StatusView {
  readonly status: VpnState
  readonly profileId?: string
  readonly profileName?: string
  readonly iface?: string
  readonly ip?: string
  readonly connectedAt?: string
  readonly uptimeSeconds?: number
  readonly error?: string
  readonly pid?: number
  readonly routes: readonly string[]
  readonly watchdog: { readonly state: WatchdogState; readonly secondsLeft?: number; readonly reason?: string }
  readonly install: InstallView
  readonly allowCustom?: boolean
  readonly updatedAt: string
}

/** One log line (already redacted by the host). */
export interface LogLine {
  readonly t: string
  readonly level: 'info' | 'warn' | 'error' | 'out'
  readonly text: string
}

/** Body of `PUT /api/vpn/profile`. `secret` is write-only; omit it to keep the stored one. */
export interface ProfileInput {
  readonly id?: string
  readonly name: string
  readonly type: ProfileType
  readonly host?: string
  readonly port?: number
  readonly username?: string
  readonly realm?: string
  readonly trustedCert?: string
  readonly targets: readonly string[]
  readonly setDns: boolean
  readonly command?: readonly string[]
  readonly secret?: string
}

/** Everything the page renders, read in one pass. */
export interface VpnSnapshot {
  readonly fetchedAt: string
  readonly status: StatusView
  readonly profiles: readonly ProfileView[]
  readonly logs: readonly LogLine[]
  /** `mock` is built-in sample data, always labelled in the header. */
  readonly origin: 'host' | 'mock'
  readonly staleSince?: string
}
