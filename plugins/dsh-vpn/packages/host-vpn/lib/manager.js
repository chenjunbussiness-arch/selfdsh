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
import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { connect as tcpConnect } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseV4Net } from "./cidr.js";
import { CONFIG_PLACEHOLDER, fetchCookie, parseLine, planCookie, planPassword, supportsCookie, INSTALL_HINT } from "./forti.js";
import { checkTargets, defaultRouteKey, parseRouteTable, protectedAddresses, v4Targets } from "./guard.js";
import { redact, secretsOfUrl } from "./redact.js";
import { writePrivate } from "./store.js";
/** Thrown for a request that is invalid in the current state. */
export class ConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConflictError';
    }
}
/** Ring buffer size. */
export const LOG_LINES = 200;
/** Real command runner: argv array, no shell. */
async function defaultExec(argv) {
    const [command, ...args] = argv;
    if (command === undefined)
        return { code: 127, stdout: '', stderr: 'empty command' };
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let child;
        try {
            child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env['PATH'] ?? '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
        }
        catch (error) {
            resolve({ code: 127, stdout: '', stderr: String(error) });
            return;
        }
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
        child.on('error', (error) => { resolve({ code: 127, stdout, stderr: error.message }); });
        child.on('close', (code) => { resolve({ code: code ?? 1, stdout, stderr }); });
    });
}
/** Real TCP reachability probe. */
function defaultTcp(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const socket = tcpConnect({ host, port });
        const done = (ok) => { socket.destroy(); resolve(ok); };
        socket.setTimeout(timeoutMs, () => { done(false); });
        socket.once('connect', () => { done(true); });
        socket.once('error', () => { done(false); });
    });
}
/** Resolve every IPv4 and IPv6 address of a host name. */
async function defaultLookup(host) {
    const found = await lookup(host, { all: true });
    return found.map(entry => entry.address);
}
/** Default pid liveness check. */
function defaultAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/** Default `/proc/<pid>/cmdline` reader (Linux). */
async function defaultCmdline(pid) {
    try {
        return (await readFile(`/proc/${String(pid)}/cmdline`, 'utf8')).replace(/\0/g, ' ');
    }
    catch {
        return undefined;
    }
}
/** The manager. */
export class VpnManager {
    o;
    status = 'disconnected';
    profile;
    iface;
    ip;
    connectedAt;
    error;
    routes = [];
    watchState = 'idle';
    watchUntil = 0;
    watchReason;
    child;
    exited;
    stopping = false;
    generation = 0;
    timers = new Set();
    logs = [];
    secrets = [];
    installCache;
    tempConfig;
    constructor(o) {
        this.o = o;
    }
    now() {
        return (this.o.now ?? Date.now)();
    }
    exec(argv) {
        return (this.o.exec ?? defaultExec)(argv);
    }
    // --- logging ---------------------------------------------------------------
    log(level, text) {
        const line = { t: new Date(this.now()).toISOString(), level, text: redact(text, this.secrets).slice(0, 500) };
        this.logs.push(line);
        if (this.logs.length > LOG_LINES)
            this.logs.splice(0, this.logs.length - LOG_LINES);
    }
    /** The newest log lines, already redacted. */
    logLines(limit = LOG_LINES) {
        return this.logs.slice(-Math.max(1, Math.min(limit, LOG_LINES)));
    }
    // --- install detection -----------------------------------------------------
    /** Detect the openfortivpn binary (cached for a minute). */
    async install(force = false) {
        if (this.o.detect !== undefined)
            return this.o.detect();
        if (!force && this.installCache !== undefined && this.now() - this.installCache.at < 60_000)
            return this.installCache.info;
        const version = await this.exec([...this.o.exe, '--version']);
        const pppd = existsSync('/usr/sbin/pppd');
        let info;
        if (version.code !== 0) {
            info = { installed: false, version: '', cookieSupport: false, pppd, hint: INSTALL_HINT };
        }
        else {
            const help = await this.exec([...this.o.exe, '--help']);
            info = {
                installed: true,
                version: (version.stdout.trim().split('\n')[0] ?? '').slice(0, 40),
                cookieSupport: supportsCookie(`${help.stdout}${help.stderr}`),
                pppd,
                hint: pppd ? '' : 'apt-get install -y ppp   # pppd is missing; openfortivpn needs it',
            };
        }
        this.installCache = { at: this.now(), info };
        return info;
    }
    // --- status ----------------------------------------------------------------
    /** Current state, without secrets. */
    async statusDocument() {
        const now = this.now();
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
        };
    }
    /** Current status string only. */
    get state() {
        return this.status;
    }
    // --- connect ---------------------------------------------------------------
    /**
     * Start connecting a profile. Resolves once the child is started (or the
     * attempt has already failed); the state moves on in the background.
     * @param id - profile id.
     * @returns the state right after the request.
     * @throws {ConflictError} when a connection is already starting or up.
     */
    async connect(id) {
        if (this.status === 'connecting' || this.status === 'connected') {
            throw new ConflictError(`already ${this.status}; disconnect first (only one profile at a time)`);
        }
        const profile = await this.o.store.get(id);
        if (profile === undefined)
            throw new ConflictError(`profile ${id} not found`);
        const generation = ++this.generation;
        this.profile = profile;
        this.status = 'connecting';
        this.error = undefined;
        this.iface = undefined;
        this.ip = undefined;
        this.connectedAt = undefined;
        this.routes = [];
        this.watchState = 'idle';
        this.watchReason = undefined;
        this.stopping = false;
        this.secrets = [];
        this.log('info', `connecting "${profile.name}" (${profile.type})`);
        try {
            await this.start(profile, generation);
        }
        catch (error) {
            if (generation === this.generation)
                this.fail(error instanceof Error ? error.message : String(error));
        }
        return this.statusDocument();
    }
    /** Everything before the child is running; throws a message-only Error to fail the attempt. */
    async start(profile, generation) {
        if (profile.targets.length === 0)
            throw new Error('this profile has no targets; refusing to connect without a split-tunnel list');
        if (profile.type === 'custom' && !this.o.allowCustom)
            throw new Error('custom commands are disabled');
        const secret = await this.o.store.readSecret(profile.id);
        if (secret === undefined && profile.type !== 'custom')
            throw new Error('no password / token URL is stored for this profile');
        if (secret !== undefined)
            this.secrets = profile.type === 'password' ? [secret] : secretsOfUrl(secret);
        const info = await this.install(true);
        if (profile.type !== 'custom') {
            if (!info.installed)
                throw new Error(`openfortivpn is not installed. Install it on the server:\n${info.hint}`);
            if (profile.type === 'token-url' && !info.cookieSupport) {
                throw new Error('the installed openfortivpn is too old for token URLs (no --cookie-on-stdin); install 1.18 or newer');
            }
        }
        // Resolve targets and make sure none of them can take the server off the network.
        const resolved = await this.resolveTargets(profile);
        const before = defaultRouteKey((await this.exec(['ip', '-4', 'route', 'show', 'default'])).stdout);
        const table = parseRouteTable((await this.exec(['ip', '-4', 'route', 'show'])).stdout);
        const extra = [];
        const probe = this.probeTarget();
        if (probe !== undefined && parseV4Net(probe.host) !== undefined)
            extra.push({ label: 'the watchdog probe address', address: probe.host });
        for (const address of await this.gatewayAddresses(profile))
            extra.push({ label: 'the VPN gateway', address });
        const problem = checkTargets(table, v4Targets(resolved.v4), protectedAddresses(table, extra));
        if (problem !== undefined)
            throw new Error(problem);
        let plan;
        if (profile.type === 'password') {
            plan = planPassword(profile, secret ?? '');
        }
        else if (profile.type === 'token-url') {
            this.log('info', `requesting a session cookie from ${profile.host}:${String(profile.port)} (one HTTPS GET, redirects not followed)`);
            const cookie = await (this.o.cookie ?? fetchCookie)(secret ?? '', profile.trustedCert, 15_000);
            this.secrets = [...this.secrets, cookie];
            plan = planCookie(profile, cookie);
        }
        else {
            plan = {
                args: profile.command.slice(1).map(arg => arg.replaceAll('{url}', secret ?? '')),
                config: undefined,
                stdin: undefined,
                secrets: [],
            };
        }
        if (generation !== this.generation || this.stopping)
            return;
        let command;
        let args;
        if (profile.type === 'custom') {
            command = profile.command[0] ?? '';
            args = [...plan.args];
        }
        else {
            command = this.o.exe[0] ?? 'openfortivpn';
            args = [...this.o.exe.slice(1), ...plan.args];
        }
        if (plan.config !== undefined) {
            await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
            this.tempConfig = join(this.o.dir, `run-${randomBytes(6).toString('hex')}.conf`);
            await writePrivate(this.tempConfig, plan.config);
            args = args.map(arg => (arg === CONFIG_PLACEHOLDER ? this.tempConfig ?? arg : arg));
        }
        const spawnFn = this.o.spawn ?? nodeSpawn;
        const child = spawnFn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { PATH: process.env['PATH'] ?? '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', ...this.o.env },
        });
        this.child = child;
        this.exited = new Promise((resolve) => {
            child.once('close', (code, signal) => {
                this.onExit(generation, code, signal);
                resolve();
            });
        });
        child.once('error', (error) => {
            this.log('error', `could not start the process: ${error.message}`);
            if (generation === this.generation)
                this.fail(`could not start the process: ${error.message}`);
        });
        // A child that dies before reading stdin must not crash the plugin on EPIPE.
        child.stdin?.on('error', () => { });
        if (plan.stdin !== undefined)
            child.stdin?.write(plan.stdin);
        child.stdin?.end();
        if (child.pid !== undefined) {
            await mkdir(this.o.dir, { recursive: true, mode: 0o700 });
            await writePrivate(join(this.o.dir, 'run.json'), JSON.stringify({ pid: child.pid, startedAt: new Date(this.now()).toISOString(), marker: this.marker(), profileId: profile.id }));
        }
        this.pipeLines(child, generation, before, resolved);
        this.after(this.o.connectTimeoutMs, () => {
            if (generation === this.generation && this.status === 'connecting')
                this.fail(`timed out after ${String(Math.round(this.o.connectTimeoutMs / 1000))}s waiting for the tunnel`);
        });
    }
    /** A string that identifies our child in `/proc/<pid>/cmdline`. */
    marker() {
        const last = this.o.exe[this.o.exe.length - 1] ?? 'openfortivpn';
        return last.split(/[\\/]/).pop() ?? 'openfortivpn';
    }
    probeTarget() {
        const text = this.o.publicProbe;
        const at = text.lastIndexOf(':');
        if (text === '' || at <= 0)
            return undefined;
        const port = Number(text.slice(at + 1));
        return Number.isInteger(port) && port > 0 && port < 65536 ? { host: text.slice(0, at), port } : undefined;
    }
    async gatewayAddresses(profile) {
        if (profile.host === '')
            return [];
        if (parseV4Net(profile.host) !== undefined)
            return [profile.host];
        try {
            return (await (this.o.lookupAll ?? defaultLookup)(profile.host)).filter(address => parseV4Net(address) !== undefined);
        }
        catch {
            return [];
        }
    }
    /** Turn host-name targets into addresses now, before the tunnel can change what the resolver answers. */
    async resolveTargets(profile) {
        const v4 = [];
        const v6 = [];
        for (const target of profile.targets) {
            if (parseV4Net(target) !== undefined) {
                v4.push(target);
                continue;
            }
            if (target.includes(':')) {
                v6.push(target);
                continue;
            }
            let addresses;
            try {
                addresses = await (this.o.lookupAll ?? defaultLookup)(target);
            }
            catch {
                throw new Error(`cannot resolve target host "${target}"; use its IP address or CIDR (internal names may only resolve through the VPN's DNS)`);
            }
            if (addresses.length === 0)
                throw new Error(`target host "${target}" has no address`);
            for (const address of addresses) {
                if (address.includes(':'))
                    v6.push(`${address}/128`);
                else
                    v4.push(`${address}/32`);
            }
        }
        return { v4, v6 };
    }
    pipeLines(child, generation, before, resolved) {
        let routing = false;
        const onLine = (level) => (raw) => {
            if (generation !== this.generation)
                return;
            const line = raw.replace(/\r/g, '').trimEnd();
            if (line === '')
                return;
            this.log(level, line);
            const facts = parseLine(redact(line, this.secrets));
            if (facts.iface !== undefined)
                this.iface = facts.iface;
            if (facts.ip !== undefined)
                this.ip = facts.ip;
            if (facts.error !== undefined)
                this.error = facts.error;
            if (facts.ready === true && !routing && this.status === 'connecting') {
                routing = true;
                void this.onReady(generation, before, resolved);
            }
        };
        if (child.stdout !== null)
            createInterface({ input: child.stdout }).on('line', onLine('out'));
        if (child.stderr !== null)
            createInterface({ input: child.stderr }).on('line', onLine('out'));
    }
    /** The tunnel is up: add only the user's routes, then watch. */
    async onReady(generation, before, resolved) {
        try {
            const iface = this.iface;
            if (this.profile?.type === 'custom' && iface === undefined) {
                this.log('warn', 'custom command: no interface name seen in its output; no routes were added by the plugin');
            }
            else {
                if (iface === undefined || !/^[a-z][a-z0-9_.-]{0,14}$/i.test(iface))
                    throw new Error('the tunnel is up but its interface name is unknown; refusing to add routes');
                for (const target of resolved.v4)
                    await this.addRoute(['ip', '-4', 'route', 'add', target, 'dev', iface], target);
                for (const target of resolved.v6)
                    await this.addRoute(['ip', '-6', 'route', 'add', target, 'dev', iface], target);
            }
            if (generation !== this.generation || this.status !== 'connecting')
                return;
            // Re-check right away: routes were added by this plugin only, so any change is ours to undo.
            const after = defaultRouteKey((await this.exec(['ip', '-4', 'route', 'show', 'default'])).stdout);
            if (after !== before)
                throw new Error(`watchdog: the default route changed (${before === '' ? 'none' : before} -> ${after === '' ? 'none' : after})`);
            this.status = 'connected';
            this.connectedAt = this.now();
            this.log('info', `connected; ${String(this.routes.length)} route(s) added, default route untouched`);
            this.startWatchdog(generation, before);
        }
        catch (error) {
            if (generation === this.generation)
                this.fail(error instanceof Error ? error.message : String(error));
        }
    }
    async addRoute(argv, target) {
        const result = await this.exec(argv);
        if (result.code !== 0)
            throw new Error(`could not add route ${target}: ${redact(result.stderr.trim(), this.secrets) || `exit ${String(result.code)}`}`);
        this.routes.push(target);
        this.log('info', `route added: ${target} -> ${this.iface ?? '?'}`);
    }
    // --- watchdog --------------------------------------------------------------
    startWatchdog(generation, before) {
        this.watchState = 'watching';
        this.watchUntil = this.now() + this.o.watchdogMs;
        let tcpFailures = 0;
        const probe = this.probeTarget();
        const tcp = this.o.tcp ?? defaultTcp;
        const tick = async () => {
            if (generation !== this.generation || this.status !== 'connected')
                return;
            const key = defaultRouteKey((await this.exec(['ip', '-4', 'route', 'show', 'default'])).stdout);
            if (key !== before) {
                this.trip(`default route changed (${before} -> ${key === '' ? 'none' : key})`);
                return;
            }
            if (this.watchState === 'watching') {
                const [local, pub] = await Promise.all([
                    this.o.localProbePort > 0 ? tcp('127.0.0.1', this.o.localProbePort, 2000) : Promise.resolve(true),
                    probe === undefined ? Promise.resolve(true) : tcp(probe.host, probe.port, 3000),
                ]);
                if (generation !== this.generation || this.status !== 'connected')
                    return;
                if (local && pub)
                    tcpFailures = 0;
                else if (++tcpFailures >= 2) {
                    this.trip(!local ? `cannot reach the local DSH service on 127.0.0.1:${String(this.o.localProbePort)}` : `cannot reach ${this.o.publicProbe} over the normal route`);
                    return;
                }
                if (this.now() >= this.watchUntil) {
                    this.watchState = 'passed';
                    this.log('info', `watchdog passed (${String(Math.round(this.o.watchdogMs / 1000))}s)`);
                }
            }
            this.after(this.watchState === 'watching' ? this.o.watchdogIntervalMs : this.o.guardIntervalMs, () => { void tick(); });
        };
        void tick();
    }
    trip(reason) {
        this.watchState = 'tripped';
        this.watchReason = reason;
        this.log('error', `watchdog tripped: ${reason}; disconnecting`);
        this.fail(`watchdog: ${reason}`);
    }
    after(ms, run) {
        const timer = setTimeout(() => { this.timers.delete(timer); run(); }, ms);
        timer.unref();
        this.timers.add(timer);
    }
    clearTimers() {
        for (const timer of this.timers)
            clearTimeout(timer);
        this.timers.clear();
    }
    // --- failure, exit, disconnect --------------------------------------------
    /** Record a failure and take the tunnel down. */
    fail(reason) {
        if (this.status === 'failed' || this.status === 'disconnected')
            return;
        this.status = 'failed';
        this.error = redact(this.error !== undefined && reason.startsWith('exited') ? `${this.error}` : reason, this.secrets);
        this.log('error', `failed: ${this.error}`);
        this.clearTimers();
        if (this.watchState === 'watching')
            this.watchState = 'idle';
        this.killChild();
    }
    killChild() {
        const child = this.child;
        if (child === undefined || child.exitCode !== null || child.signalCode !== null)
            return;
        child.kill('SIGTERM');
        const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL'); }, this.o.killGraceMs);
        timer.unref();
    }
    onExit(generation, code, signal) {
        void this.cleanupFiles();
        if (generation !== this.generation)
            return;
        this.child = undefined;
        this.clearTimers();
        this.routes = [];
        if (this.stopping) {
            this.status = 'disconnected';
            this.log('info', 'disconnected');
        }
        else if (this.status === 'connecting' || this.status === 'connected') {
            this.fail(this.error ?? `the process exited (${signal ?? `code ${String(code)}`})`);
            this.child = undefined;
        }
        if (this.watchState === 'watching')
            this.watchState = 'idle';
    }
    async cleanupFiles() {
        const config = this.tempConfig;
        this.tempConfig = undefined;
        if (config !== undefined)
            await rm(config, { force: true }).catch(() => { });
        await rm(join(this.o.dir, 'run.json'), { force: true }).catch(() => { });
    }
    /**
     * Stop the tunnel.
     * @returns the state afterwards.
     */
    async disconnect() {
        const exited = this.exited;
        if (this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null) {
            this.stopping = true;
            this.clearTimers();
            this.log('info', 'disconnect requested');
            this.child.kill('SIGTERM');
            const hard = setTimeout(() => { this.child?.kill('SIGKILL'); }, this.o.killGraceMs);
            hard.unref();
            await exited;
            clearTimeout(hard);
        }
        else if (this.status !== 'disconnected') {
            this.clearTimers();
            this.status = 'disconnected';
            this.error = undefined;
            this.watchState = 'idle';
            this.routes = [];
        }
        this.status = 'disconnected';
        this.stopping = false;
        return this.statusDocument();
    }
    /** Stop everything when the plugin is disposed: a tunnel never outlives its owner. */
    async dispose() {
        this.generation++;
        this.clearTimers();
        const child = this.child;
        if (child !== undefined && child.exitCode === null) {
            this.stopping = true;
            child.kill('SIGTERM');
            const exited = this.exited;
            const hard = setTimeout(() => { child.kill('SIGKILL'); }, this.o.killGraceMs);
            hard.unref();
            await exited;
            clearTimeout(hard);
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
    async recover() {
        const file = join(this.o.dir, 'run.json');
        let pid;
        let marker;
        try {
            const parsed = JSON.parse(await readFile(file, 'utf8'));
            if (typeof parsed.pid !== 'number' || !Number.isInteger(parsed.pid) || parsed.pid <= 1)
                throw new Error('bad pid');
            pid = parsed.pid;
            marker = typeof parsed.marker === 'string' ? parsed.marker : 'openfortivpn';
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return 'no leftover tunnel';
            await rm(file, { force: true }).catch(() => { });
            return 'removed an unreadable run.json';
        }
        const alive = this.o.isAlive ?? defaultAlive;
        let message;
        if (!alive(pid)) {
            message = `leftover pid ${String(pid)} is gone`;
        }
        else {
            const cmdline = await (this.o.readCmdline ?? defaultCmdline)(pid);
            if (cmdline === undefined || !cmdline.includes(marker)) {
                message = `pid ${String(pid)} is alive but is not ${marker}; left alone`;
            }
            else {
                process.kill(pid, 'SIGTERM');
                for (let i = 0; i < 20 && alive(pid); i++)
                    await new Promise(resolve => setTimeout(resolve, 100));
                if (alive(pid))
                    process.kill(pid, 'SIGKILL');
                message = `stopped leftover ${marker} (pid ${String(pid)}) from a previous run`;
            }
        }
        await rm(file, { force: true }).catch(() => { });
        this.log('warn', message);
        return message;
    }
}
