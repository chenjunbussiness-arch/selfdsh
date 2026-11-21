/**
 * Host half of `dsh-egress`: a fail-closed, per-host egress for model requests.
 *
 * What it does on activation:
 *
 * 1. opens the exit store (`<DSH home>/egress/config.json` unless `dataDir` says otherwise);
 * 2. wraps `globalThis.fetch` so each request leaves through the exit its target
 *    host is bound to (see `./dispatch.ts` for the rules and why this reaches
 *    the model provider);
 * 3. mounts the HTTP bridge at `/api/egress/*` once `webServer` exists;
 * 4. registers one read-only tool, `egress_status`.
 *
 * Changes made in the panel apply to the next request. Only the first
 * activation of the plugin needs a dsh-web restart.
 *
 * @module host-egress
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { BRIDGE_BASE, createRoutes } from "./bridge.js";
import { EgressRuntime, installHook } from "./dispatch.js";
import { buildState, providerHosts, statusText } from "./state.js";
import { EgressStore } from "./store.js";
/** Stable plugin name. */
export const name = 'host-egress';
/** The tool registry is a hard dependency; `webServer` is mounted lazily. */
export const inject = ['tools'];
/**
 * Mount the plugin.
 * @param ctx - Cordis context.
 * @param config - plugin config.
 */
export function apply(ctx, config = {}) {
    const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
    const dir = config.dataDir === undefined || config.dataDir === '' ? join(home, 'egress') : resolve(config.dataDir);
    const store = new EgressStore(dir);
    try {
        store.ensureDir();
    }
    catch (error) {
        ctx.logger.warn(`dsh-egress: cannot create ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const providers = providerHosts(config.providers);
    const hook = installHook(original => new EgressRuntime({
        store,
        directFetch: original,
        ...config.undiciPath === undefined ? {} : { undiciPath: config.undiciPath },
        providers,
    }));
    const runtime = hook.runtime;
    const undici = runtime.undiciStatus();
    const snapshot = store.snapshot();
    ctx.logger.info(`dsh-egress: fetch hook installed (data ${dir}); undici ${undici.ok ? (undici.version ?? 'ok') : `UNAVAILABLE (${undici.error ?? ''})`}; `
        + `${String(snapshot.config.exits.length)} exit(s), default ${snapshot.config.defaultExit}`
        + (snapshot.corrupt === undefined ? '' : `; CONFIG UNREADABLE, non-loopback requests are blocked: ${snapshot.corrupt}`));
    // The hook outlives this plugin on purpose: removing it on dispose would turn
    // every proxied host into a direct connection. Only the cached dispatchers go.
    ctx.effect(() => () => { runtime.dispose(); }, 'dsh-egress: dispatchers');
    ctx.effect(() => ctx.tools.register({
        name: 'egress_status',
        description: 'Read-only: which proxy exit each model endpoint host currently uses, the default exit, '
            + 'the last probe result of each exit and whether the hook is active. Proxy credentials are never shown. '
            + 'Exits can only be changed by a person in the Egress panel.',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                required: ['text'],
                properties: { text: { type: 'string' } },
            },
            render: (_args, value) => [{ type: 'text', text: value.text }],
        },
        isConcurrencySafe: () => true,
        execute() {
            return Promise.resolve({ text: statusText(buildState(runtime, hook.isActive(), providers)) });
        },
    }), 'dsh-egress: tool egress_status');
    if (typeof ctx.inject !== 'function') {
        ctx.logger.info('dsh-egress: this context has no ctx.inject; the HTTP bridge is not mounted (hook and tool only)');
        return;
    }
    const routes = createRoutes({ logger: ctx.logger, runtime, hookActive: hook.isActive, providers });
    ctx.inject(['webServer'], (webCtx) => {
        const webServer = webCtx.webServer;
        if (webServer === undefined || typeof webServer.register !== 'function') {
            ctx.logger.warn('dsh-egress: webServer exposes no register(); the HTTP bridge is not mounted');
            return;
        }
        for (const route of routes)
            webCtx.effect(() => webServer.register(route), `dsh-egress: ${route.path}`);
        ctx.logger.info(`dsh-egress: HTTP bridge mounted at ${BRIDGE_BASE} (state/exit/binding/probe)`);
    });
}
export { EgressError, EgressRuntime, installHook, loadUndici, PROBE_URL } from "./dispatch.js";
export { EgressStore } from "./store.js";
export { createRoutes } from "./bridge.js";
export { buildState, statusText } from "./state.js";
