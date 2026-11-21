/**
 * Everything specific to openfortivpn: argv, config file, log parsing, and the
 * one HTTPS step the token-URL type needs.
 *
 * Option facts (checked against openfortivpn 1.20 `src/main.c` / man page; the
 * 1.17.1 package in Ubuntu 22.04 does NOT have `--cookie`):
 *
 * - `--no-routes` / `--set-routes=0`  do not touch the routing table;
 * - `--set-dns=0` / `--no-dns`        do not write /etc/resolv.conf;
 * - `--pppd-use-peerdns=0`            do not let pppd write /etc/resolv.conf;
 * - `--cookie-on-stdin`               read `SVPNCOOKIE` from stdin (keeps it out of argv / `ps`);
 * - `-c <file>`                       config file; the only way to hand over a password without argv
 *                                     (`-p` shows in `ps`, and there is no password-on-stdin).
 *
 * @module host-vpn/forti
 */
import { createHash } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
/** Placeholder in `args` for the config file path. */
export const CONFIG_PLACEHOLDER = '__CONFIG__';
/**
 * Build the launch plan of a `password` profile.
 * @param profile - stored fields.
 * @param password - the stored password.
 * @returns args that never change routes and, unless asked, never touch DNS.
 */
export function planPassword(profile, password) {
    const config = [
        `host = ${profile.host}`,
        `port = ${String(profile.port)}`,
        `username = ${profile.username}`,
        `password = ${password}`,
        ...profile.realm === '' ? [] : [`realm = ${profile.realm}`],
        ...profile.trustedCert === '' ? [] : [`trusted-cert = ${profile.trustedCert}`],
        '',
    ].join('\n');
    return { args: ['-c', CONFIG_PLACEHOLDER, ...splitFlags(profile)], config, stdin: undefined, secrets: [password] };
}
/**
 * Build the launch plan of a `token-url` profile, given the session cookie.
 * @param profile - stored fields.
 * @param cookie - the SVPNCOOKIE value.
 * @returns a plan that passes the cookie on stdin.
 */
export function planCookie(profile, cookie) {
    return {
        args: [
            // Without `-c`, openfortivpn would read /etc/openfortivpn/config; point it at nothing.
            '-c', '',
            `${profile.host}:${String(profile.port)}`,
            '--cookie-on-stdin',
            ...profile.realm === '' ? [] : [`--realm=${profile.realm}`],
            ...profile.trustedCert === '' ? [] : [`--trusted-cert=${profile.trustedCert}`],
            ...splitFlags(profile),
        ],
        config: undefined,
        stdin: `${cookie}\n`,
        secrets: [cookie],
    };
}
/** The flags every plan shares: no routes, DNS only when the profile asks. */
function splitFlags(profile) {
    return [
        '--no-routes',
        `--set-dns=${profile.setDns ? '1' : '0'}`,
        `--pppd-use-peerdns=${profile.setDns ? '1' : '0'}`,
    ];
}
/**
 * Read facts out of one openfortivpn log line.
 * @param line - one line, already redacted.
 * @returns whatever it says about the tunnel.
 */
export function parseLine(line) {
    const facts = {};
    const iface = /Interface ([a-z][a-z0-9_.-]{0,14}) is UP/i.exec(line) ?? /Using interface ([a-z][a-z0-9_.-]{0,14})/i.exec(line);
    if (iface?.[1] !== undefined)
        facts.iface = iface[1];
    const ip = /Got addresses: \[(\d{1,3}(?:\.\d{1,3}){3})\]/i.exec(line) ?? /local IP address (\d{1,3}(?:\.\d{1,3}){3})/i.exec(line);
    if (ip?.[1] !== undefined)
        facts.ip = ip[1];
    if (/Tunnel is up and running/i.test(line))
        facts.ready = true;
    const trust = /--trusted-cert\s+([0-9a-f]{64})/i.exec(line);
    if (trust?.[1] !== undefined)
        facts.error = `the gateway certificate is not trusted: its sha256 digest is ${trust[1]}; if you trust it, put that in "trusted cert"`;
    else if (/Could not authenticate/i.test(line))
        facts.error = 'authentication failed: check the account, password and realm';
    else if (/certificate validation failed/i.test(line)) {
        const digest = /([0-9a-f]{64})/i.exec(line);
        facts.error = digest === null
            ? 'the gateway certificate is not trusted: set trusted-cert to its sha256 digest'
            : `the gateway certificate is not trusted: its sha256 digest is ${digest[1] ?? ''}; if you trust it, put that in "trusted cert"`;
    }
    else if (/Could not resolve|Name or service not known/i.test(line))
        facts.error = 'the gateway host name cannot be resolved';
    else if (/Connection refused|Connection timed out|No route to host|Could not connect/i.test(line))
        facts.error = 'the gateway cannot be reached';
    else if (/^ERROR:/i.test(line.trim()))
        facts.error = line.replace(/^\s*ERROR:\s*/i, '').trim().slice(0, 200);
    return facts;
}
/** Whether `--help` output advertises `--cookie-on-stdin`. */
export function supportsCookie(helpText) {
    return helpText.includes('cookie-on-stdin');
}
/** Shell text the UI shows when the binary is missing. Never executed by the plugin. */
export const INSTALL_HINT = [
    'apt-get update && apt-get install -y openfortivpn ppp   # Ubuntu 22.04 ships 1.17.1: password login only',
    '# token URL login needs openfortivpn >= 1.18 (--cookie-on-stdin): build from source or use a newer package',
].join('\n');
/** Normalise a certificate fingerprint to bare lower-case hex. */
function bareFingerprint(value) {
    return value.replace(/:/g, '').toLowerCase();
}
/** Largest response head read; the body is never read. */
const MAX_HEAD_BYTES = 16 * 1024;
/**
 * Pull the SVPNCOOKIE value out of a raw HTTP response head.
 * @param head - status line and headers.
 * @returns the cookie value, or the failure reason (never containing the URL).
 */
export function cookieFromHead(head) {
    const lines = head.split('\r\n');
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? '')?.[1] ?? '0');
    if (status >= 300 && status < 400)
        return { error: `the gateway answered with a redirect (HTTP ${String(status)}); not followed` };
    for (const line of lines.slice(1)) {
        const match = /^set-cookie:\s*SVPNCOOKIE=([^;\s]+)/i.exec(line);
        if (match?.[1] !== undefined && match[1] !== '' && match[1] !== '0')
            return { cookie: match[1] };
    }
    return { error: `the gateway answered HTTP ${String(status)} without an SVPNCOOKIE; this URL form may not be a login link (use the custom command type)` };
}
/**
 * Exchange the user's token URL for a session cookie.
 *
 * This is the whole audited step: ONE `GET` to the exact URL the user stored,
 * written by hand on a TLS socket so that nothing (no redirect handling, no
 * agent, no proxy variable) can send the token anywhere else. A 30x is an
 * error. Only the response head is read, for `Set-Cookie: SVPNCOOKIE=…`.
 *
 * TLS: with no `trustedCert` the certificate is verified normally. With one, the
 * chain check is skipped and the connection is accepted only when the
 * certificate's sha256 digest equals it, which is the rule openfortivpn applies.
 * (Node's `checkServerIdentity` hook cannot be used for this: it is not called
 * when chain verification already failed, which is exactly the self-signed case.)
 * @param url - the stored https URL, query included.
 * @param trustedCert - allowed sha256 digest, or empty.
 * @param timeoutMs - overall timeout.
 * @returns the cookie value (after `SVPNCOOKIE=`).
 * @throws {Error} with a message free of the URL and of any token.
 */
export const fetchCookie = (url, trustedCert, timeoutMs) => new Promise((resolve, reject) => {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        reject(new Error('the stored URL cannot be parsed'));
        return;
    }
    if (parsed.protocol !== 'https:') {
        reject(new Error('the stored URL is not https'));
        return;
    }
    const wanted = bareFingerprint(trustedCert);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    const port = parsed.port === '' ? 443 : Number(parsed.port);
    let settled = false;
    const done = (outcome) => {
        if (settled)
            return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if ('cookie' in outcome)
            resolve(outcome.cookie);
        else
            reject(new Error(outcome.error));
    };
    const socket = tlsConnect({
        host,
        port,
        servername: /^[0-9.]+$|:/.test(host) ? undefined : host,
        rejectUnauthorized: wanted === '',
    });
    const timer = setTimeout(() => { done({ error: 'the gateway did not answer in time' }); }, timeoutMs);
    timer.unref();
    let received = '';
    socket.on('secureConnect', () => {
        if (wanted !== '') {
            const raw = socket.getPeerCertificate().raw;
            const digest = raw === undefined ? '' : createHash('sha256').update(raw).digest('hex');
            if (digest !== wanted) {
                done({ error: 'the gateway certificate does not match the trusted digest' });
                return;
            }
        }
        socket.write(`GET ${parsed.pathname}${parsed.search} HTTP/1.1\r\nHost: ${parsed.host}\r\nUser-Agent: Mozilla/5.0 SV1\r\nAccept: */*\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
        received += chunk.toString('latin1');
        const end = received.indexOf('\r\n\r\n');
        if (end >= 0)
            done(cookieFromHead(received.slice(0, end)));
        else if (received.length > MAX_HEAD_BYTES)
            done({ error: 'the gateway response head is too large' });
    });
    socket.on('error', (error) => { done({ error: `request failed: ${error.message.replace(/\?[^\s]*/g, '?***')}` }); });
    socket.on('close', () => { done({ error: 'the gateway closed the connection without answering' }); });
});
