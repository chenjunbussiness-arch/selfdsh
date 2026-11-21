/**
 * Node (Host) half of the package.
 *
 * The router panel is a Client-only contribution: it renders what the Host's
 * router bundle already decided, so there is nothing to compute on this side and
 * nothing to configure. This half exists because the profile loads a package
 * through its Host entry before the Web shell mounts its `dsh.client` half; a
 * package without one cannot be activated at all.
 *
 * The board's own Host logic (partitions, routing, verification, worker
 * dispatch) belongs to `packages/host-router`, which exposes it to this panel
 * through the `router` Remote described in `docs/CONTRACT.md`.
 */

/** Cordis plugin name, surfaced in profile diagnostics. */
export const name = 'client-ui-router'

/** No Host services are required: this half contributes nothing. */
export const inject: readonly string[] = []

/**
 * Activate the Host half.
 *
 * Intentionally empty: everything this package ships is browser-side. Keeping a
 * real function (rather than omitting the export) keeps the plugin a normal
 * Cordis plugin that the Loader can enable, disable, and reload like any other.
 */
export function apply(): void {}
