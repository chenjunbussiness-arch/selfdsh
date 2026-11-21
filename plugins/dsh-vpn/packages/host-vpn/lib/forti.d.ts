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
import type { StoredProfile } from './validate.ts';
/** What the tunnel-start code needs from a profile and its secret. */
export interface LaunchPlan {
    /** Arguments after the executable. */
    readonly args: readonly string[];
    /** Config file text to write (0600) before spawn, if the plan uses one. Replace `__CONFIG__` in `args` with its path. */
    readonly config: string | undefined;
    /** Text to write to the child's stdin. */
    readonly stdin: string | undefined;
    /** Values that must never appear in a log line. */
    readonly secrets: readonly string[];
}
/** Placeholder in `args` for the config file path. */
export declare const CONFIG_PLACEHOLDER = "__CONFIG__";
/**
 * Build the launch plan of a `password` profile.
 * @param profile - stored fields.
 * @param password - the stored password.
 * @returns args that never change routes and, unless asked, never touch DNS.
 */
export declare function planPassword(profile: StoredProfile, password: string): LaunchPlan;
/**
 * Build the launch plan of a `token-url` profile, given the session cookie.
 * @param profile - stored fields.
 * @param cookie - the SVPNCOOKIE value.
 * @returns a plan that passes the cookie on stdin.
 */
export declare function planCookie(profile: StoredProfile, cookie: string): LaunchPlan;
/** One fact read from a log line. */
export interface LineFacts {
    readonly iface?: string;
    readonly ip?: string;
    /** `Tunnel is up and running`: routes may be added now. */
    readonly ready?: boolean;
    /** A line that explains why the connection failed. */
    readonly error?: string;
}
/**
 * Read facts out of one openfortivpn log line.
 * @param line - one line, already redacted.
 * @returns whatever it says about the tunnel.
 */
export declare function parseLine(line: string): LineFacts;
/** Whether `--help` output advertises `--cookie-on-stdin`. */
export declare function supportsCookie(helpText: string): boolean;
/** Shell text the UI shows when the binary is missing. Never executed by the plugin. */
export declare const INSTALL_HINT: string;
/** What {@link fetchCookie} needs; injectable so tests need no network. */
export type CookieFetcher = (url: string, trustedCert: string, timeoutMs: number) => Promise<string>;
/**
 * Pull the SVPNCOOKIE value out of a raw HTTP response head.
 * @param head - status line and headers.
 * @returns the cookie value, or the failure reason (never containing the URL).
 */
export declare function cookieFromHead(head: string): {
    cookie: string;
} | {
    error: string;
};
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
export declare const fetchCookie: CookieFetcher;
