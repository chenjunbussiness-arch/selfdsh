/**
 * Log redaction.
 *
 * Two layers, because neither alone is enough: exact known secret values
 * (the stored password, the whole token URL, the token query value, the session
 * cookie) are replaced wherever they appear, and a set of key=value patterns
 * catches secrets the plugin did not know about (a cookie the gateway printed,
 * a `password =` line from a verbose client).
 *
 * @module host-vpn/redact
 */
/** What replaces a secret. */
export declare const MASK = "***";
/**
 * Pull every secret-bearing piece out of a URL.
 * @param url - the full URL the user pasted.
 * @returns the URL itself, its query values, and its userinfo password.
 */
export declare function secretsOfUrl(url: string): string[];
/**
 * Replace secrets in one line of text.
 * @param text - the raw line.
 * @param secrets - exact secret values to remove wherever they appear.
 * @returns the line with every secret replaced by {@link MASK}.
 */
export declare function redact(text: string, secrets?: readonly string[]): string;
