/**
 * Code hosting adapters: GitHub and Gitea behind one interface.
 *
 * The router talks to a code host for exactly four things: find the pull
 * request of a branch, open or update it, read its checks, and merge it. Both
 * hosts expose these over REST with nearly the same shapes, so one small
 * interface covers both and a partition switches host by configuration alone
 * (`git.scm.provider`), which is how a repository moves from GitHub to a
 * self-hosted Gitea without touching code.
 *
 * Tokens: the adapter never stores a token. The caller passes a resolver that
 * reads the environment variable named in the configuration at call time, and
 * no error message, log line or result ever includes it.
 *
 * @module host-router/scm
 */
/** Which code host a partition's repository lives on. */
export type ScmProvider = 'github' | 'gitea';
/** Code host settings of one partition (`git.scm` in the configuration). */
export interface ScmConfig {
    readonly provider: ScmProvider;
    /** `owner/name`. */
    readonly repo: string;
    /**
     * API base. GitHub defaults to `https://api.github.com`; Gitea needs its own,
     * for example `https://git.example.com` (the adapter adds `/api/v1`).
     */
    readonly baseUrl?: string;
    /** Environment variable holding the token; defaults to `GITHUB_TOKEN` / `GITEA_TOKEN`. */
    readonly tokenEnv?: string;
    /** Branch pull requests target; read from the host when absent. */
    readonly defaultBranch?: string;
    /** Git remote to push to (default `origin`). */
    readonly remote?: string;
}
/** A pull request as the router reports it. */
export interface PullView {
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly state: 'open' | 'closed' | 'merged';
    readonly head: string;
    readonly base: string;
    readonly headSha: string;
    /** `true`/`false` when the host knows, `undefined` while it is still computing. */
    readonly mergeable?: boolean;
    readonly draft: boolean;
}
/** Combined check result of one commit. */
export interface ChecksView {
    readonly state: 'success' | 'failure' | 'pending' | 'none';
    readonly total: number;
    readonly failing: readonly string[];
    readonly pending: readonly string[];
}
/** What the router asks of a code host. */
export interface ScmClient {
    readonly provider: ScmProvider;
    readonly repo: string;
    defaultBranch(): Promise<string>;
    /** The open pull request whose head is `branch`, if any. */
    findOpen(branch: string): Promise<PullView | undefined>;
    get(number: number): Promise<PullView>;
    open(input: {
        head: string;
        base: string;
        title: string;
        body: string;
        draft?: boolean;
    }): Promise<PullView>;
    update(number: number, input: {
        title?: string;
        body?: string;
    }): Promise<PullView>;
    checks(sha: string): Promise<ChecksView>;
    merge(number: number, method: 'merge' | 'squash' | 'rebase', sha?: string): Promise<{
        merged: boolean;
        message: string;
    }>;
}
/** Error from a code host; `status` is the HTTP status, 0 for a network failure. */
export declare class ScmError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
/** `fetch` as far as the adapters use it, so tests can pass a fake. */
export type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;
/**
 * Validate one `git.scm` block.
 * @returns the problem, or undefined when it is usable.
 */
export declare function scmProblem(raw: unknown): string | undefined;
/** Default token variable of a provider. */
export declare const defaultTokenEnv: (provider: ScmProvider) => string;
/** Read a token from the environment; never logged. */
export declare const envToken: (config: ScmConfig) => string | undefined;
/**
 * Build a client for one partition's repository.
 * @param config - the partition's `git.scm` block.
 * @param token - resolves the token at call time (undefined: anonymous reads only).
 * @param fetchImpl - `fetch`; injectable for tests.
 */
export declare function createScmClient(config: ScmConfig, token: () => string | undefined, fetchImpl?: FetchLike): ScmClient;
