/**
 * Input validation and redaction for the egress store and bridge.
 *
 * Everything that crosses the HTTP bridge is checked here, because an exit
 * record is later turned into a network destination and a header value: a
 * newline in a host name or a user name is a header-injection primitive, and an
 * unchecked host is a way to point the server at something it should not reach.
 *
 * @module host-egress/validate
 */
/** Exit kinds a person may define. `direct` is built in and never stored. */
export declare const PROXY_TYPES: readonly ["http", "https", "socks5"];
/** One definable exit kind. */
export type ProxyType = (typeof PROXY_TYPES)[number];
/** Exit kinds including the built-in direct exit. */
export type ExitType = ProxyType | 'direct';
/** Id of the built-in exit that connects straight out. */
export declare const DIRECT_ID = "direct";
/** A validation failure with a stable code the panel can print. */
export declare class ValidationError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Validate and normalise a host name or IP literal.
 *
 * Accepts DNS names and IPv4/IPv6 literals (IPv6 with or without brackets) and
 * returns the lower-case form without brackets. Rejects anything that looks like
 * a URL, a path, credentials or a port.
 * @param raw - candidate host.
 * @param field - field name for messages.
 * @returns the normalised host.
 */
export declare function validateHost(raw: unknown, field?: string): string;
/**
 * Validate a TCP port.
 * @param raw - number or numeric string.
 * @returns the port, 1..65535.
 */
export declare function validatePort(raw: unknown): number;
/**
 * Validate a proxy type against the whitelist; `socks5h` is accepted as socks5.
 * @param raw - candidate type.
 * @returns the stored type.
 */
export declare function validateType(raw: unknown): ProxyType;
/**
 * Validate an exit's display name.
 * @param raw - candidate name.
 * @returns the trimmed name, 1..40 characters.
 */
export declare function validateName(raw: unknown): string;
/**
 * Validate an exit id.
 * @param raw - candidate id.
 * @returns the id.
 */
export declare function validateId(raw: unknown): string;
/**
 * Validate proxy credentials.
 * @param raw - candidate value.
 * @param field - `username` or `password`.
 * @returns the value.
 */
export declare function validateCredential(raw: unknown, field: 'username' | 'password'): string;
/** What `host:port` renders to, bracketing IPv6. */
export declare function hostPort(host: string, port: number): string;
/**
 * Redact a proxy URL: userinfo is always `***:***`, never the real values.
 * @param scheme - proxy scheme.
 * @param host - proxy host.
 * @param port - proxy port.
 * @param hasAuth - whether credentials exist.
 * @returns `scheme://[***:***@]host:port`.
 */
export declare function redactedUrl(scheme: string, host: string, port: number, hasAuth: boolean): string;
/**
 * Remove secrets from free text such as an upstream error message.
 *
 * Masks every `scheme://userinfo@` and every literal secret value passed in.
 * @param text - text to clean.
 * @param secrets - literal values to mask.
 * @returns the cleaned text.
 */
export declare function scrub(text: string, secrets?: readonly string[]): string;
/** Whether a host names this machine; loopback never leaves it, so no exit applies. */
export declare function isLoopbackHost(hostname: string): boolean;
