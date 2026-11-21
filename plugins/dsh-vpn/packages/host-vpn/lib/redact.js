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
export const MASK = '***';
/** Shortest literal worth replacing; shorter values would shred ordinary words. */
const MIN_LITERAL = 3;
/** Query parameters whose value is always a secret. */
const SECRET_QUERY = /([?&](?:token|access_token|auth|key|sig|signature|cookie|svpncookie|password|passwd|pwd)=)[^&\s"'<>]+/gi;
/** `name = value` / `name: value` shapes whose name says the value is a secret. */
const AUTH_HEADER = /\b(authorization\s*[=:]\s*)(?:(?:bearer|basic|token)\s+)?[^\s,;&"']+/gi;
const SECRET_PAIR = /\b(password|passwd|pwd|token|cookie|svpncookie|pem-passphrase|passphrase|secret)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"']+)/gi;
/** The session cookie as it appears in a header or a log line. */
const COOKIE = /(SVPNCOOKIE=)[^\s;"']+/gi;
/** Percent-encode like `encodeURIComponent` but also keep a form-encoded variant. */
function variants(value) {
    const out = new Set([value]);
    try {
        out.add(encodeURIComponent(value));
        out.add(encodeURI(value));
        out.add(value.replace(/ /g, '+'));
        // Every non-alphanumeric byte percent-encoded, in both hex cases (an encoder may escape "~" or "!").
        const all = [...Buffer.from(value, 'utf8')]
            .map(byte => (/[A-Za-z0-9]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, '0')}`))
            .join('');
        out.add(all);
        out.add(all.replace(/%[0-9a-f]{2}/g, hex => hex.toUpperCase()));
    }
    catch {
        // A lone surrogate cannot be encoded; the raw form is still replaced.
    }
    return [...out];
}
/**
 * Pull every secret-bearing piece out of a URL.
 * @param url - the full URL the user pasted.
 * @returns the URL itself, its query values, and its userinfo password.
 */
export function secretsOfUrl(url) {
    const out = [url];
    try {
        const parsed = new URL(url);
        for (const [, value] of parsed.searchParams)
            if (value !== '')
                out.push(value);
        if (parsed.password !== '')
            out.push(parsed.password);
        if (parsed.search.length > 1)
            out.push(parsed.search.slice(1));
    }
    catch {
        // Not a parseable URL: the whole string is still replaced as a literal.
    }
    return out;
}
/**
 * Replace secrets in one line of text.
 * @param text - the raw line.
 * @param secrets - exact secret values to remove wherever they appear.
 * @returns the line with every secret replaced by {@link MASK}.
 */
export function redact(text, secrets = []) {
    let out = text;
    const literals = secrets
        .filter(value => value.length >= MIN_LITERAL)
        .flatMap(variants)
        .sort((left, right) => right.length - left.length);
    for (const literal of literals)
        out = out.split(literal).join(MASK);
    return out
        .replace(COOKIE, `$1${MASK}`)
        .replace(SECRET_QUERY, `$1${MASK}`)
        .replace(AUTH_HEADER, `$1${MASK}`)
        .replace(SECRET_PAIR, `$1$2${MASK}`);
}
