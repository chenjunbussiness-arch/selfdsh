/**
 * The rail's API-key block.
 *
 * A status block, not a secret store. It shows, per reference, whether a value
 * exists and where it came from; the only write it can perform is "store this
 * literal", which is the same call the official Models page makes
 * (`ctx.remote.credentials.set`). Nothing here ever reads a value back, because
 * the Host's credential seam has no read path at all — the block cannot leak what
 * it cannot fetch.
 *
 * When the Host exposes no credential write, the rows stay readable and the
 * block says where the official entry is instead of offering a dead button.
 */
import type { CredentialView } from './contract.ts';
/** Props for {@link Credentials}. */
export interface CredentialsProps {
    /** Status rows, already resolved by the panel (live Host answer or board snapshot). */
    readonly rows: readonly CredentialView[];
    /** Namespace-bound translate. */
    readonly t: (key: string, values?: Record<string, string | number>) => string;
    /** True when the Host implements a credential write. */
    readonly writable: boolean;
    /**
     * Store one literal.
     * @param ref - credential reference name.
     * @param value - the literal to store.
     * @returns a refusal message, or undefined once stored.
     */
    readonly onSave?: (ref: string, value: string) => Promise<string | undefined>;
    /** Called after a successful write, so the panel can re-read status. */
    readonly onChanged?: () => void;
}
/**
 * Render the API-key block.
 * @param props - rows, translate, and the optional write path.
 * @returns the rail's credential section.
 */
export declare function Credentials({ rows, t, writable, onSave, onChanged }: CredentialsProps): import("react/jsx-runtime").JSX.Element;
