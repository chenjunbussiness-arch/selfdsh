/**
 * Sources for the panel: the host's HTTP bridge, and in-memory sample data.
 *
 * The bridge is same-origin (`/api/egress/*`, mounted by `packages/host-egress`
 * on the Web server), so the browser needs no new transport and no credential of
 * its own. Writes send `application/json`, which a cross-origin page cannot do
 * without a CORS preflight the server never grants.
 */
import type { EgressSource } from './contract.ts';
/** Where the host's bridge lives. Mirrors `BRIDGE_BASE` in the host package. */
export declare const BRIDGE_BASE = "/api/egress";
/** Options for {@link createHttpSource}. */
export interface HttpSourceOptions {
    readonly base?: string;
    /** Test seam. */
    readonly fetchImpl?: typeof fetch;
}
/**
 * Build the source that talks to the host's HTTP bridge.
 * @param options - base path and test fetch.
 * @returns the source.
 */
export declare function createHttpSource(options?: HttpSourceOptions): EgressSource;
/** The pair the controller works with: the real bridge and the sample fallback. */
export declare function defaultSources(): {
    readonly host: EgressSource;
    readonly mock: () => EgressSource;
};
