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
import { createRoutes } from './bridge.ts';
import { VpnManager } from './manager.ts';
import type { StatusDocument } from './manager.ts';
import { ProfileStore } from './store.ts';
import type { PluginContext } from './types.ts';
/** Stable plugin name. */
export declare const name = "host-vpn";
/** Only the tool registry is required; the web server is injected optionally. */
export declare const inject: string[];
/** Plugin config, every key optional. */
export interface VpnConfig {
    readonly dir?: string;
    /** Executable, or an argv prefix. */
    readonly openfortivpn?: string | readonly string[];
    readonly watchdogSeconds?: number;
    readonly localProbePort?: number;
    readonly publicProbe?: string;
    readonly allowCustomCommand?: boolean;
    readonly recoverOnStart?: boolean;
}
/** One-paragraph, secret-free rendering of the status for an agent. */
export declare function describeStatus(status: StatusDocument): string;
/**
 * Activate the plugin.
 * @param ctx - Cordis plugin context.
 * @param config - plugin config from `cordis.patch.yml`.
 */
export declare function apply(ctx: PluginContext, config?: VpnConfig): Promise<void>;
export { createRoutes, ProfileStore, VpnManager };
export type { StatusDocument };
