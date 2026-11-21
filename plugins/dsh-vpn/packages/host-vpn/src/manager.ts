/**
 * The connection manager: one openfortivpn child, a state machine, a log ring,
 * split-tunnel routes, and the watchdog.
 *
 * Why a plain child process and not a systemd transient unit: the child is
 * bound to this plugin. If the plugin is disposed the tunnel is torn down with
 * it, and `run.json` lets the next start find and kill a child that outlived a
 * hard crash. A transient unit would keep the tunnel alive after DSH is gone,
 * which is the opposite of what this plugin wants for a tunnel that can cut off
 * the server's own access.
 *
 * State machine:
 *
 *   disconnected ──connect──▶ connecting ──ready+routes+watchdog window──▶ connected
 *        ▲                        │                                          │
 *        │                        └────────── error / timeout ──▶ failed ◀───┘ (process died, watchdog tripped)
 *        └────────────── disconnect (from any state) ───────────────────────┘
 *
 * @module host-vpn/manager
 */

import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { connect as tcpConnect } from 'node:net'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { parseV4Net } from './cidr.ts'
import { CONFIG_PLACEHOLDER, fetchCookie, parseLine, planCookie, planPassword, supportsCookie, INSTALL_HINT } from './forti.ts'
import type { CookieFetcher, LaunchPlan } from './forti.ts'
import { checkTargets, defaultRouteKey, parseRouteTable, protectedAddresses, v4Targets } from './guard.ts'
import type { ProtectedAddress } from './guard.ts'
import { redact, secretsOfUrl } from './redact.ts'
import type { ProfileStore } from './store.ts'
import { writePrivate } from './store.ts'
import type { LoggerService } from './types.ts'
import type { StoredProfile } from './validate.ts'

/** Connection states. */
export type VpnStatus = 'disconnected' | 'connecting' | 'connected' | 'failed'

/** Watchdog states. */
export type WatchdogState = 'idle' | 'watching' | 'passed' | 'tripped'

/** One log line. */
export interface LogLine {
  readonly t: string
  readonly level: 'info' | 'warn' | 'error' | 'out'
  readonly text: string
}

/** What is known about the openfortivpn binary. */
export interface InstallInfo {
  readonly installed: boolean
  readonly version: string
  readonly cookieSupport: boolean
  readonly pppd: boolean
  readonly hint: string
}

/** The document `GET /api/vpn/status` answers with. Holds no secret. */
export interface StatusDocument {
  readonly status: VpnStatus
  readonly profileId: string | undefined
  readonly profileName: string | undefined
  readonly iface: string | undefined
  readonly ip: string | undefined
  readonly connectedAt: string | undefined
  readonly uptimeSeconds: number | undefined
  readonly error: string | undefined
  readonly pid: number | undefined
  readonly routes: readonly string[]
  readonly watchdog: { readonly state: WatchdogState; readonly secondsLeft: number | undefined; readonly reason: string | undefined }
  readonly install: InstallInfo
  readonly updatedAt: string
}

/** Result of an external command. */
export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Everything the manager touches outside itself, injectable for tests. */
export interface ManagerOptions {
  readonly store: ProfileStore
  /** Private directory for `run.json` and temporary config files. */
  readonly dir: string
  /** openfortivpn executable plus fixed leading arguments. */
  readonly exe: readonly string[]
  readonly logger: LoggerService
  readonly allowCustom: boolean
  readonly watchdogMs: number
  readonly watchdogIntervalMs: number
  readonly guardIntervalMs: number
  readonly connectTimeoutMs: number
  readonly killGraceMs: number
  /** Port of the local DSH web service the watchdog must still reach; 0 disables the check. */
  readonly localProbePort: number
  /** `host:port` that must stay reachable over the normal route; empty disables the check. */
  readonly publicProbe: string
  readonly spawn?: typeof nodeSpawn
  readonly exec?: (argv: readonly string[]) => Promise<ExecResult>
  readonly tcp?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
  readonly lookupAll?: (host: string) => Promise<string[]>
  readonly cookie?: CookieFetcher
  readonly detect?: () => Promise<InstallInfo>
  readonly readCmdline?: (pid: number) => Promise<string | undefined>
  readonly isAlive?: (pid: number) => boolean
  readonly env?: Readonly<Record<string, string>>
  readonly now?: () => number
}

/** Thrown for a request that is invalid in the current state. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

/** Ring buffer size. */
export const LOG_LINES = 200

/** Real command runner: argv array, no shell. */
async function defaultExec(argv: readonly string[]): Promise<ExecResult> {
  const [command, ...args] = argv
  if (command === undefined) return { code: 127, stdout: '', stderr: 'empty command' }
  return new Promise<ExecResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ChildProcess
    try {
      child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } })
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: String(error) })
      return
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => { resolve({ code: 127, stdout, stderr: error.message }) })
    child.on('close', (code) => { resolve({ code: code ?? 1, stdout, stderr }) })
  })
}

/** Real TCP reachability probe. */
function defaultTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = tcpConnect({ host, port })
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => { done(false) })
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
}

/** Resolve every IPv4 and IPv6 address of a host name. */
async function defaultLookup(host: string): Promise<string[]> {
  const found = await lookup(host, { all: true })
  return found.map(entry => entry.address)
}

/** Default pid liveness check. */
function defaultAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Default `/proc/<pid>/cmdline` reader (Linux). */
async function defaultCmdline(pid: number): Promise<string | undefined> {
  try {
    return (await readFile(`/proc/${String(pid)}/cmdline`, 'utf8')).replace(/\0/g, ' ')
  } catch {
    return undefined
  }
}

/** The manager. */
export class VpnManager {
  private status: VpnStatus = 'disconnected'
  private profile: StoredProfile | undefined
  private iface: string | undefined
  private ip: string | undefined
  private connectedAt: number | undefined
  private error: string | undefined
  private routes: string[] = []
  private watchState: WatchdogState = 'idle'
  private watchUntil = 0
  private watchReason: string | undefined
  private child: ChildProcess | undefined
  private exited: Promise<void> | undefined
  private stopping = false
  private generation = 0
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly logs: LogLine[] = []
  private secrets: string[] = []
  private installCache: { at: number; info: InstallInfo } | undefined
  private tempConfig: string | undefined

  constructor(private readonly o: ManagerOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  private exec(argv: readonly string[]): Promise<ExecResult> {
    return (this.o.exec ?? defaultExec)(argv)
  }

  // --- logging ---------------------------------------------------------------

  private log(level: LogLine['level'], text: string): void {
    const line: LogLine = { t: new Date(this.now()).toISOString(), level, text: redact(text, this.secrets).slice(0, 500) }
    this.logs.push(line)
    if (this.logs.length > LOG_LINES) this.logs.splice(0, this.logs.length - LOG_LINES)
  }

  /** The newest log lines, already redacted. */
  logLines(limit = LOG_LINES): LogLine[] {
    return this.logs.slice(-Math.max(1, Math.min(limit, LOG_LINES)))
  }

  // --- install detection -----------------------------------------------------

  /** Detect the openfortivpn binary (cached for a minute). */
  async install(force = false): Promise<InstallInfo> {
    if (this.o.detect !== undefined) return this.o.detect()
    if (!force && this.installCache !== undefined && this.now() - this.installCache.at < 60_000) return this.installCache.info
    const version = await this.exec([...this.o.exe, '--version'])
    const pppd = existsSync('/usr/sbin/pppd')
    let info: InstallInfo
    if (version.code !== 0) {
      info = { installed: false, version: '', cookieSupport: false, pppd, hint: INSTALL_HINT }
    } else {
      const help = await this.exec([...this.o.exe, '--help'])
      info = {
        installed: true,
        version: (version.stdout.trim().split('\n')[0] ?? '').slice(0, 40),
        cookieSupport: supportsCookie(`${help.stdout}${help.stderr}`),
        pppd,
        hint: pppd ? '' : 'apt-get install -y ppp   # pppd is missing; openfortivpn needs it',
      }
    }
    this.installCache = { at: this.now(), info }
    return info
  }

  // --- status ----------------------------------------------------------------

  /** Current state, without secrets. */
  async statusDocument(): Promise<StatusDocument> {
    const now = this.now()
    return {
      status: this.status,
      profileId: this.profile?.id,
      profileName: this.profile?.name,
      iface: this.iface,
      ip: this.ip,
      connectedAt: this.connectedAt === undefined ? undefined : new Date(this.connectedAt).toISOString(),
      uptimeSeconds: this.status === 'connected' && this.connectedAt !== undefined ? Math.max(0, Math.round((now - this.connectedAt) / 1000)) : undefined,
      error: this.error,
      pid: this.child?.pid,
      routes: [...this.routes],
      watchdog: {
        state: this.watchState,
        secondsLeft: this.watchState === 'watching' ? Math.max(0, Math.ceil((this.watchUntil - now) / 1000)) : undefined,
        reason: this.watchReason,
      },
      install: await this.install(),
      updatedAt: new Date(now).toISOString(),
    }
  }

  /** Current status string only. */
  get state(): VpnStatus {
    return this.status
  }

  // --- connect ---------------------------------------------------------------

  /**
   * Start connecting a profile. Resolves once the child is started (or the
   * attempt has already failed); the state moves on in the background.
   * @param id - profile id.
   * @returns the state right after the request.
   * @throws {ConflictError} when a connection is already starting or up.
   */
  async connect(id: string): Promise<StatusDocument> {
    if (this.status === 'connecting' || this.status === 'connected') {
      throw new ConflictError(`already ${this.status}; disconnect first (only one profile at a time)`)
    }
    const profile = await this.o.store.get(id)
    if (profile === undefined) throw new ConflictError(`profile ${id} not found`)
    const generation = ++this.generation
    this.profile = profile
    this.status = 'connecting'
    this.error = undefined
    this.iface = undefined
    this.ip = undefined
    this.connectedAt = undefined
    this.routes = []
    this.watchState = 'idle'
    this.watchReason = undefined
    this.stopping = false
    this.secrets = []
    this.log('info', `connecting "${profile.name}" (${profile.type})`)
    try {
      await this.start(profile, generation)
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : String(error))
    }
    return this.statusDocument()
  }

  /** Everything before the child is running; throws a message-only Error to fail the attempt. */
  private async start(profile: StoredProfile, generation: number): Promise<void> {
    if (profile.targets.length === 0) throw new Error('this profile has no targets; refusing to connect without a split-tunnel list')
    if (profile.type === 'custom' && !this.o.allowCustom) throw new Error('custom commands are disabled')
    const secret = await this.o.store.readSecret(profile.id)
    if (secret === undefined && profile.type !== 'custom') throw new Error('no password / token URL is stored for this profile')
    if (secret !== undefined) this.secrets = profile.type === 'password' ? [secret] : secretsOfUrl(secret)

    const info = await this.install(true)
    if (profile.type !== 'custom') {
      if (!info.installed) throw new Error(`openfortivpn is not installed. Install it on the server:\n${info.hint}`)
      if (profile.type === 'token-url' && !info.cookieSupport) {
        throw new Error('the installed openfortivpn is too old for token URLs (no --cookie-on-stdin); install 1.18 or newer')
      }
    }

    // Resolve targets and make sure none of them can take the server off the network.
    const resolved = await this.resolveTargets(profile)
    const before = defaultRouteKey((await this.exec(['ip', '-4', 'route', 'show', 'default'])).stdout)
    const table = parseRouteTable((await this.exec(['ip', '-4', 'route', 'show'])).stdout)
    const extra: ProtectedAddress[] = []
    const probe = this.probeTarget()
    if (probe !== undefined && parseV4Net(probe.host) !== undefined) extra.push({ label: 'the watchdog probe address', address: probe.host })
    for (const address of await this.gatewayAddresses(profile)) extra.push({ label: 'the VPN gateway', address })
    const problem = checkTargets(table, v4Targets(resolved.v4), protectedAddresses(table, extra))
    if (problem !== undefined) throw new Error(problem)

    let plan: LaunchPlan
    if (profile.type === 'password') {
      plan = planPassword(profile, secret ?? '')
    } else if (profile.type === 'token-url') {
      this.log('info', `requesting a session cookie from ${profile.host}:${String(profile.port)} (one HTTPS GET, redirects not followed)`)
      const cookie = await (this.o.cookie ?? fetchCookie)(secret ?? '', profile.trustedCert, 15_000)
      this.secrets = [...this.secrets, cookie]
      plan = planCookie(profile, cookie)
    } else {
      plan = {
        args: profile.command.slice(1).map(arg => arg.replaceAll('{url}', secret ?? '')),
        config: undefined,
        stdin: undefined,
        secrets: [],
      }
    }
    if (generation !== this.generation || this.stopping) return

    let command: string
    let args: string[]
    if (profile.type === 'custom') {
      command = profile.command[0] ?? ''
      args = [...plan.args]
    } else {
      command = this.o.exe[0] ?? 'openfortivpn'
      args = [...this.o.exe.slice(1), ...plan.args]
    }
    if (plan.config !== undefined) {
      await mkdir(this.o.dir, { recursive: true, mode: 0o700 })
      this.tempConfig = join(this.o.dir, `run-${randomBytes(6).toString('hex')}.conf`)
      await writePrivate(this.tempConfig, plan.config)
      args = args.map(arg => (arg === CONFIG_PLACEHOLDER ? this.tempConfig ?? arg : arg))
    }

    const spawnFn = this.o.spawn ?? nodeSpawn
    const child = spawnFn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env['PATH'] ?? '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', ...this.o.env },
    })
    this.child = child
    this.exited = new Promise<void>((resolve) => {
      child.once('close', (code, signal) => {
        this.onExit(generation, code, signal)
        resolve()
      })
    })
    child.once('error', (error: Error) => {
      this.log('error', `could not start the process: ${error.message}`)
      if (generation === this.generation) this.fail(`could not start the process: ${error.message}`)
    })
    // A child that dies before reading stdin must not crash the plugin on EPIPE.
    child.stdin?.on('error', () => {})
    if (plan.stdin !== undefined) child.stdin?.write(plan.stdin)
    child.stdin?.end()
    if (child.pid !== undefined) {
      await mkdir(this.o.dir, { recursive: true, mode: 0o700 })
      await writePrivate(join(this.o.dir, 'run.json'), JSON.stringify({ pid: child.pid, startedAt: new Date(this.now()).toISOString(), marker: this.marker(), profileId: profile.id }))
    }
    this.pipeLines(child, generation, before, resolved)
    this.after(this.o.connectTimeoutMs, () => {
      if (generation === this.generation && this.status === 'connecting') this.fail(`timed out after ${String(Math.round(this.o.connectTimeoutMs / 1000))}s waiting for the tunnel`)
    })
  }

  /** A string that identifies our child in `/proc/<pid>/cmdline`. */
  private marker(): string {
    const last = this.o.exe[this.o.exe.length - 1] ?? 'openfortivpn'
    return last.split(/[\\/]/).pop() ?? 'openfortivpn'
  }

  private probeTarget(): { host: string; port: number } | undefined {
    const text = this.o.publicProbe
    const at = text.lastIndexOf(':')
    if (text === '' || at <= 0) return undefined
    const port = Number(text.slice(at + 1))
    return Number.isInteger(port) && port > 0 && port < 65536 ? { host: text.slice(0, at), port } : undefined
  }

  private async gatewayAddresses(profile: StoredProfile): Promise<string[]> {
    if (profile.host === '') return []
    if (parseV4Net(profile.host) !== undefined) return [profile.host]
    try {
      return (await (this.o.lookupAll ?? defaultLookup)(profile.host)).filter(address => parseV4Net(address) !== undefined)
    } catch {
      return []
    }
  }

  /** Turn host-name targets into addresses now, before the tunnel can change what the resolver answers. */
  private async resolveTargets(profile: StoredProfile): Promise<{ v4: string[]; v6: string[] }> {
    const v4: string[] = []
    const v6: string[] = []
    for (const target of profile.targets) {
      if (parseV4Net(target) !== undefined) { v4.push(target); continue }
      if (target.includes(':')) { v6.push(target); continue }
      let addresses: string[]
      try {
        addresses = await (this.o.lookupAll ?? defaultLookup)(target)
      } catch {
        throw new Error(`cannot resolve target host "${target}"; use its IP address or CIDR (internal names may only resolve through the VPN's DNS)`)
      }
      if (addresses.length === 0) throw new Error(`target host "${target}" has no address`)
      for (const address of addresses) {
        if (address.includes(':')) v6.push(`${address}/128`)
        else v4.push(`${address}/32`)
      }
    }
    return { v4, v6 }
  }

  private pipeLines(child: ChildProcess, generation: number, before: string, resolved: { v4: string[]; v6: string[] }): void {
    let routing = false
    const onLine = (level: LogLine['level']) => (raw: string): void => {
      if (generation !== this.generation) return
      const line = raw.replace(/\r/g, '').trimEnd()
      if (line === '') return
      this.log(level, line)
      const facts = parseLine(redact(line, this.secrets))
      if (facts.iface !== undefined) this.iface = facts.iface
      if (facts.ip !== undefined) this.ip = facts.ip
      if (facts.error !== undefined) this.error = facts.error
      if (facts.ready === true && !routing && this.status === 'connecting') {
        routing = true
        void this.onReady(generation, before, resolved)
      }
    }
    if (child.stdout !== null) createInterface({ input: child.stdout }).on('line', onLine('out'))
    if (child.stderr !== null) createInterface({ input: child.stderr }).on('line', onLine('out'))
  }

  /** The tunnel is up: add only the user's routes, then watch. */
  private async onReady(generation: number, before: string, resolved: { v4: string[]; v6: string[] }): Promise<void> {
    try {
      const iface = this.iface
      if (this.profile?.type === 'custom' && iface === undefined) {
        this.log('warn', 'custom command: no interface name seen in its output; no routes were added by the plugin')
      } else {
        if (iface === undefined || !/^[a-z][a-z0-9_.-]{0,14}$/i.test(iface)) throw new Error('the tunnel is up but its interface name is unknown; refusing to add routes')
        for (const target of resolved.v4) await this.addRoute(['ip', '-4', 'route', 'add', target, 'dev', iface], target)
        for (const target of resolved.v6) await this.addRoute(['ip', '-6', 'route', 'add', target, 'dev', iface], target)
      }
      if (generation !== this.generation || this.status !== 'connecting') return
      // Re-check right away: routes were added by this plugin only, so any change is ours to undo.
      const after = defaultRouteKey((await this.exec(['ip', '-4', 'route', 'show', 'default'])).stdout)
      if (after !== before) throw new Error(`watchdog: the default route changed (${before === '' ? 'none' : before} -> ${after === '' ? 'none' : after})`)
      this.status = 'connected'
      this.connectedAt = this.now()
      this.log('info', `connected; ${String(this.routes.length)} route(s) added, default route untouched`)
      this.startWatchdog(generation, before)
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private async addRoute(argv: readonly string[], target: string): Promise<void> {
    const result = await this.exec(argv)
    if (result.code !== 0) throw new Error(`could not add route ${target}: ${redact(result.stderr.trim(), this.secrets) || `exit ${String(result.code)}`}`)
    this.routes.push(target)
    this.log('info', `route added: ${target} -> ${this.iface ?? '?'}`)
  }

  // --- watchdog --------------------------------------------------------------

  private startWatchdog(generation: number, before: string): void {
    this.watchState = 'watching'
    this.watchUntil = this.now() + this.o.watchdogMs
    let tcpFailures = 0
    const probe = this.probeTarget()
    const tcp = this.o.tcp ?? defaultTcp
    const tick = async (): Promise<void> => {
      if (generation !== this.generation || this.status !== 'connected') return
      const key = defaultRouteKey((await this.exec(['ip', '-4', 'route', 'show', 'default'])).stdout)
      if (key !== before) { this.trip(`default route changed (${before} -> ${key === '' ? 'none' : key})`); return }
      if (this.watchState === 'watching') {
        const [local, pub] = await Promise.all([
          this.o.localProbePort > 0 ? tcp('127.0.0.1', this.o.localProbePort, 2000) : Promise.resolve(true),
          probe === undefined ? Promise.resolve(true) : tcp(probe.host, probe.port, 3000),
        ])
        if (generation !== this.generation || this.status !== 'connected') return
        if (local && pub) tcpFailures = 0
        else if (++tcpFailures >= 2) {
          this.trip(!local ? `cannot reach the local DSH service on 127.0.0.1:${String(this.o.localProbePort)}` : `cannot reach ${this.o.publicProbe} over the normal route`)
          return
        }
        if (this.now() >= this.watchUntil) {
          this.watchState = 'passed'
          this.log('info', `watchdog passed (${String(Math.round(this.o.watchdogMs / 1000))}s)`)
        }
      }
      this.after(this.watchState === 'watching' ? this.o.watchdogIntervalMs : this.o.guardIntervalMs, () => { void tick() })
    }
    void tick()
  }

  private trip(reason: string): void {
    this.watchState = 'tripped'
    this.watchReason = reason
    this.log('error', `watchdog tripped: ${reason}; disconnecting`)
    this.fail(`watchdog: ${reason}`)
  }

  private after(ms: number, run: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); run() }, ms)
    timer.unref()
    this.timers.add(timer)
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  // --- failure, exit, disconnect --------------------------------------------

  /** Record a failure and take the tunnel down. */
  private fail(reason: string): void {
    if (this.status === 'failed' || this.status === 'disconnected') return
    this.status = 'failed'
    this.error = redact(this.error !== undefined && reason.startsWith('exited') ? `${this.error}` : reason, this.secrets)
    this.log('error', `failed: ${this.error}`)
    this.clearTimers()
    if (this.watchState === 'watching') this.watchState = 'idle'
    this.killChild()
  }

  private killChild(): void {
    const child = this.child
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, this.o.killGraceMs)
    timer.unref()
  }

  private onExit(generation: number, code: number | null, signal: NodeJS.Signals | null): void {
    void this.cleanupFiles()
    if (generation !== this.generation) return
    this.child = undefined
    this.clearTimers()
    this.routes = []
    if (this.stopping) {
      this.status = 'disconnected'
      this.log('info', 'disconnected')
    } else if (this.status === 'connecting' || this.status === 'connected') {
      this.fail(this.error ?? `the process exited (${signal ?? `code ${String(code)}`})`)
      this.child = undefined
    }
    if (this.watchState === 'watching') this.watchState = 'idle'
  }

  private async cleanupFiles(): Promise<void> {
    const config = this.tempConfig
    this.tempConfig = undefined
    if (config !== undefined) await rm(config, { force: true }).catch(() => {})
    await rm(join(this.o.dir, 'run.json'), { force: true }).catch(() => {})
  }

  /**
   * Stop the tunnel.
   * @returns the state afterwards.
   */
  async disconnect(): Promise<StatusDocument> {
    const exited = this.exited
    if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
      this.stopping = true
      this.clearTimers()
      this.log('info', 'disconnect requested')
      this.child.kill('SIGTERM')
      const hard = setTimeout(() => { this.child?.kill('SIGKILL') }, this.o.killGraceMs)
      hard.unref()
      await exited
      clearTimeout(hard)
    } else if (this.status !== 'disconnected') {
      this.clearTimers()
      this.status = 'disconnected'
      this.error = undefined
      this.watchState = 'idle'
      this.routes = []
    }
    this.status = 'disconnected'
    this.stopping = false
    return this.statusDocument()
  }

  /** Stop everything when the plugin is disposed: a tunnel never outlives its owner. */
  async dispose(): Promise<void> {
    this.generation++
    this.clearTimers()
    const child = this.child
    if (child !== undefined && child.exitCode === null) {
      this.stopping = true
      child.kill('SIGTERM')
      const exited = this.exited
      const hard = setTimeout(() => { child.kill('SIGKILL') }, this.o.killGraceMs)
      hard.unref()
      await exited
      clearTimeout(hard)
    }
  }

  // --- recovery --------------------------------------------------------------

  /**
   * Kill an openfortivpn left over from a previous run.
   *
   * It is cleaned up, not adopted: the new process has lost the child's pipes
   * (no logs, no stdin) and the watchdog context, so a tunnel it cannot watch
   * is not a tunnel it should keep.
   * @returns what was done, for the log.
   */
  async recover(): Promise<string> {
    const file = join(this.o.dir, 'run.json')
    let pid: number
    let marker: string
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown; marker?: unknown }
      if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 1) throw new Error('bad pid')
      pid = parsed.pid
      marker = typeof parsed.marker === 'string' ? parsed.marker : 'openfortivpn'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'no leftover tunnel'
      await rm(file, { force: true }).catch(() => {})
      return 'removed an unreadable run.json'
    }
    const alive = this.o.isAlive ?? defaultAlive
    let message: string
    if (!alive(pid)) {
      message = `leftover pid ${String(pid)} is gone`
    } else {
      const cmdline = await (this.o.readCmdline ?? defaultCmdline)(pid)
      if (cmdline === undefined || !cmdline.includes(marker)) {
        message = `pid ${String(pid)} is alive but is not ${marker}; left alone`
      } else {
        process.kill(pid, 'SIGTERM')
        for (let i = 0; i < 20 && alive(pid); i++) await new Promise<void>(resolve => setTimeout(resolve, 100))
        if (alive(pid)) process.kill(pid, 'SIGKILL')
        message = `stopped leftover ${marker} (pid ${String(pid)}) from a previous run`
      }
    }
    await rm(file, { force: true }).catch(() => {})
    this.log('warn', message)
    return message
  }
}
