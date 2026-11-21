/**
 * Node (Host) half of the package.
 *
 * The Egress panel is a Client-only contribution: it renders what the host
 * package `dsh-host-egress` serves at `/api/egress/*`. This half exists because
 * the profile loads a package through its Host entry before the Web shell mounts
 * its `dsh.client` half; a package without one cannot be activated at all.
 */
/** Cordis plugin name, surfaced in profile diagnostics. */
export declare const name = "client-ui-egress";
/** No Host services are required: this half contributes nothing. */
export declare const inject: readonly string[];
/** Intentionally empty: everything this package ships is browser-side. */
export declare function apply(): void;
