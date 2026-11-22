/**
 * Host half of `dsh-vpn`.
 *
 * Activation does four things:
 *   1. opens the private store (`<DSH home>/vpn`, 0700) and the connection manager;
 *   2. cleans up an openfortivpn left behind by a previous run;
 *   3. registers `vpn_status`, a read-only tool for agents (no secret, no way to connect);
 *   4. mounts the HTTP bridge on `ctx.webServer` through `ctx.inject`, independent of activation order.
 *
 * Disposing the plugin stops the tunnel: a tunnel never outlives its owner.
 *
 * @module host-vpn
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BRIDGE_BASE, createRoutes } from "./bridge.js";
import { VpnManager } from "./manager.js";
import { requireLogin } from "./login.js";
import { ProfileStore } from "./store.js";
/** Stable plugin name. */
export const name = 'host-vpn';
/** Only the tool registry is required; the web server is injected optionally. */
export const inject = ['tools'];
/** One-paragraph, secret-free rendering of the status for an agent. */
export function describeStatus(status) {
    const lines = [`status: ${status.status}`];
    if (status.profileName !== undefined)
        lines.push(`profile: ${status.profileName}`);
    if (status.iface !== undefined)
        lines.push(`interface: ${status.iface}`);
    if (status.ip !== undefined)
        lines.push(`tunnel ip: ${status.ip}`);
    if (status.uptimeSeconds !== undefined)
        lines.push(`uptime: ${String(status.uptimeSeconds)}s`);
    if (status.routes.length > 0)
        lines.push(`routed through the tunnel: ${status.routes.join(', ')}`);
    if (status.error !== undefined)
        lines.push(`last error: ${status.error}`);
    lines.push(`watchdog: ${status.watchdog.state}${status.watchdog.reason === undefined ? '' : ` (${status.watchdog.reason})`}`);
    lines.push(`openfortivpn: ${status.install.installed ? `installed ${status.install.version}` : 'not installed'}`);
    lines.push('Only a person can connect or disconnect, from the VPN page.');
    return lines.join('\n');
}
/** Clamp a number option. */
function numberOr(value, fallback, min, max) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
/**
 * Activate the plugin.
 * @param ctx - Cordis plugin context.
 * @param config - plugin config from `cordis.patch.yml`.
 */
export async function apply(ctx, config = {}) {
    const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    const dir = config.dir === undefined ? join(home, 'vpn') : resolve(config.dir);
    const exe = typeof config.openfortivpn === 'string' ? [config.openfortivpn] : [...config.openfortivpn ?? ['openfortivpn']];
    const allowCustom = config.allowCustomCommand === true;
    const options = {
        store: new ProfileStore(dir),
        dir,
        exe,
        logger: ctx.logger,
        allowCustom,
        watchdogMs: numberOr(config.watchdogSeconds, 30, 5, 600) * 1000,
        watchdogIntervalMs: 2000,
        guardIntervalMs: 15_000,
        connectTimeoutMs: 60_000,
        killGraceMs: 5000,
        localProbePort: numberOr(config.localProbePort, 42443, 0, 65535),
        publicProbe: typeof config.publicProbe === 'string' ? config.publicProbe : '223.5.5.5:53',
    };
    const store = options.store;
    await store.ensure();
    const manager = new VpnManager(options);
    if (config.recoverOnStart !== false)
        ctx.logger.info(`host-vpn: ${await manager.recover()}`);
    ctx.effect(() => () => { void manager.dispose(); }, 'vpn: stop tunnel');
    ctx.effect(() => ctx.tools.register({
        name: 'vpn_status',
        description: 'Read the state of the VPN used to reach the internal git server: whether it is connected, '
            + 'which profile, the tunnel address, uptime, the networks routed through it and the last error. '
            + 'Read-only. It cannot connect or disconnect, and it never shows a password or token; a person '
            + 'controls the VPN from the VPN page.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
            schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        async execute() {
            return { text: describeStatus(await manager.statusDocument()) };
        },
    }), 'vpn: vpn_status tool');
    const deps = { logger: ctx.logger, manager, store, allowCustom };
    if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (webCtx) => {
            const webServer = webCtx.webServer;
            if (webServer === undefined || typeof webServer.register !== 'function') {
                ctx.logger.warn('host-vpn: webServer exposes no register(); the HTTP bridge is not mounted');
                return;
            }
            // Login is checked here: a plugin route outranks the connection's own `/api` check.
            const connection = () => ctx.get?.('connection');
            for (const route of createRoutes(deps)) {
                const guarded = requireLogin(route, connection);
                webCtx.effect(() => webServer.register(guarded), `host-vpn: ${route.path}`);
            }
            ctx.logger.info(`host-vpn: HTTP bridge mounted at ${BRIDGE_BASE} (status/profiles/profile/connect/disconnect/logs)`);
        });
    }
    else {
        ctx.logger.info('host-vpn: this context has no ctx.inject; the HTTP bridge is not mounted (tool only)');
    }
    ctx.logger.info(`host-vpn: store ${dir}, watchdog ${String(options.watchdogMs / 1000)}s, custom commands ${allowCustom ? 'enabled' : 'disabled'}`);
}
export { createRoutes, ProfileStore, VpnManager };
