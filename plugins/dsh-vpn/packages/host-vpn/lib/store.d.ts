/**
 * Profile and secret storage.
 *
 * Layout under `<dir>` (default `<DSH home>/vpn`, mode 0700):
 *
 *   profiles.json      every profile, no secret in it (0600)
 *   secrets/<id>       one file per profile holding the password or token URL (0600)
 *   run.json           the running connection, for cleanup after a crash (0600)
 *
 * Why files and not `ctx.credentials`: the credential service is the model-key
 * store (`$DSH_HOME/.credentials.yaml`), its host-side read-back of a value is not
 * confirmed in the rc.3 API facts, and a VPN password has no business in the file
 * that the LLM settings page rewrites. The {@link SecretStore} seam keeps this a
 * one-class swap if that changes.
 *
 * Reads never return a secret: the only method that does is
 * {@link ProfileStore.readSecret}, which only the connection manager calls.
 *
 * @module host-vpn/store
 */
import type { StoredProfile, ValidatedProfile } from './validate.ts';
/** A profile as every read endpoint returns it. */
export interface PublicProfile extends StoredProfile {
    /** Whether a password / token URL is stored. The value is never exposed. */
    readonly secretConfigured: boolean;
}
/** Where secret values live. */
export interface SecretStore {
    has(id: string): Promise<boolean>;
    read(id: string): Promise<string | undefined>;
    write(id: string, value: string): Promise<void>;
    remove(id: string): Promise<void>;
}
/** Thrown for an id that is not stored. */
export declare class NotFoundError extends Error {
    readonly id: string;
    constructor(id: string);
}
/**
 * Write a file atomically with a private mode.
 *
 * The rename is retried with a backoff: on Windows `rename` over a file that is
 * being read fails with EPERM (HANDOFF §7.5), and the tests run there. If every
 * retry fails the content is written in place, which is still a single small
 * write.
 * @param path - target.
 * @param text - contents.
 */
export declare function writePrivate(path: string, text: string): Promise<void>;
/** Secret files under `<dir>/secrets`. */
export declare class FileSecretStore implements SecretStore {
    private readonly dir;
    constructor(dir: string);
    private path;
    has(id: string): Promise<boolean>;
    read(id: string): Promise<string | undefined>;
    write(id: string, value: string): Promise<void>;
    remove(id: string): Promise<void>;
}
/** Profile persistence. */
export declare class ProfileStore {
    readonly dir: string;
    private readonly secrets;
    private readonly clock;
    private cache;
    /** Serialises writers so two requests cannot interleave a read-modify-write. */
    private chain;
    constructor(dir: string, secrets?: SecretStore, clock?: () => Date);
    private get file();
    /** Create the private directory. */
    ensure(): Promise<void>;
    private load;
    private save;
    private exclusive;
    private publicOf;
    /** Every profile, without secrets. */
    list(): Promise<PublicProfile[]>;
    /** One profile, without its secret. */
    get(id: string): Promise<StoredProfile | undefined>;
    /** The stored secret. Only the connection manager calls this. */
    readSecret(id: string): Promise<string | undefined>;
    /**
     * Create or update a profile.
     * @param input - validated request.
     * @returns the stored profile (no secret).
     * @throws {NotFoundError} when `input.id` names nothing.
     * @throws {ValidationError} for a name clash, a missing secret on create, or a token-url update that lacks a gateway.
     */
    upsert(input: ValidatedProfile): Promise<PublicProfile>;
    /**
     * Delete a profile and its secret.
     * @param id - profile id.
     * @throws {NotFoundError} when it does not exist.
     */
    remove(id: string): Promise<void>;
}
