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
import type { EgressConfig, PluginContext } from './types.ts';
/** Stable plugin name. */
export declare const name = "host-egress";
/** The tool registry is a hard dependency; `webServer` is mounted lazily. */
export declare const inject: string[];
/**
 * Mount the plugin.
 * @param ctx - Cordis context.
 * @param config - plugin config.
 */
export declare function apply(ctx: PluginContext, config?: EgressConfig): void;
export { EgressError, EgressRuntime, installHook, loadUndici, PROBE_URL } from './dispatch.ts';
export { EgressStore } from './store.ts';
export { createRoutes } from './bridge.ts';
export { buildState, statusText } from './state.ts';
