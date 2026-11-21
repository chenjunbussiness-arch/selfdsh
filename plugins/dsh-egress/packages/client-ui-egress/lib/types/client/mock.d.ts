/**
 * Sample data and an in-memory source that behaves like the bridge.
 *
 * Used when the host bridge is unreachable (the panel then says "Sample data")
 * and by the preview. It applies the same rules the host does (an exit that is
 * still bound cannot be deleted, a new exit starts unprobed) so the panel's
 * flows can be exercised without a server. Probing is simulated: an exit whose
 * host contains `dead` or `down` fails with a connection error, every other one
 * answers with a made-up documentation-range IP.
 */
import type { EgressSource, EgressState } from './contract.ts';
/**
 * Build the sample document.
 * @param now - clock, ms.
 * @returns state with three custom exits, two bindings and a short request log.
 */
export declare function sampleState(now?: number): EgressState;
/** Options for the in-memory source. */
export interface MockOptions {
    /** Start from this state instead of {@link sampleState}. */
    readonly initial?: EgressState;
    /** Delay of a simulated probe, ms. */
    readonly probeDelayMs?: number;
}
/**
 * An in-memory source with the bridge's rules.
 * @param options - initial state and probe delay.
 * @returns the source; `origin` is `mock`.
 */
export declare function createMockSource(options?: MockOptions): EgressSource;
