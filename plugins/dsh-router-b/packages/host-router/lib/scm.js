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
/** Error from a code host; `status` is the HTTP status, 0 for a network failure. */
export class ScmError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'ScmError';
    }
}
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/**
 * Validate one `git.scm` block.
 * @returns the problem, or undefined when it is usable.
 */
export function scmProblem(raw) {
    if (raw === null || typeof raw !== 'object')
        return 'git.scm must be an object';
    const scm = raw;
    if (scm.provider !== 'github' && scm.provider !== 'gitea')
        return 'git.scm.provider must be "github" or "gitea"';
    if (typeof scm.repo !== 'string' || !REPO_RE.test(scm.repo))
        return 'git.scm.repo must be "owner/name"';
    if (scm.provider === 'gitea' && (typeof scm.baseUrl !== 'string' || !/^https?:\/\//.test(scm.baseUrl))) {
        return 'git.scm.baseUrl is required for gitea (http(s)://…)';
    }
    if (scm.baseUrl !== undefined && (typeof scm.baseUrl !== 'string' || !/^https?:\/\//.test(scm.baseUrl))) {
        return 'git.scm.baseUrl must start with http:// or https://';
    }
    if (scm.tokenEnv !== undefined && (typeof scm.tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(scm.tokenEnv))) {
        return 'git.scm.tokenEnv must be an environment variable name';
    }
    return undefined;
}
/** Default token variable of a provider. */
export const defaultTokenEnv = (provider) => provider === 'github' ? 'GITHUB_TOKEN' : 'GITEA_TOKEN';
/** Read a token from the environment; never logged. */
export const envToken = (config) => {
    const value = process.env[config.tokenEnv ?? defaultTokenEnv(config.provider)];
    return value === undefined || value.trim() === '' ? undefined : value.trim();
};
/** Strip anything token-like from a host's error body before it is shown. */
const scrub = (text) => text
    .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[token]')
    .replace(/(token|authorization)["':= ]+[^\s"',}]+/gi, '$1 [hidden]')
    .slice(0, 400);
/**
 * Build a client for one partition's repository.
 * @param config - the partition's `git.scm` block.
 * @param token - resolves the token at call time (undefined: anonymous reads only).
 * @param fetchImpl - `fetch`; injectable for tests.
 */
export function createScmClient(config, token, fetchImpl = globalThis.fetch) {
    const github = config.provider === 'github';
    const root = github
        ? (config.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
        : `${(config.baseUrl ?? '').replace(/\/+$/, '')}/api/v1`;
    const repoPath = `/repos/${config.repo}`;
    const call = async (method, path, body) => {
        const headers = {
            accept: github ? 'application/vnd.github+json' : 'application/json',
            'user-agent': 'dsh-router',
        };
        const secret = await token();
        if (secret !== undefined)
            headers.authorization = github ? `Bearer ${secret}` : `token ${secret}`;
        if (body !== undefined)
            headers['content-type'] = 'application/json';
        let response;
        try {
            response = await fetchImpl(`${root}${path}`, {
                method,
                headers,
                ...body === undefined ? {} : { body: JSON.stringify(body) },
                signal: AbortSignal.timeout(20_000),
            });
        }
        catch (error) {
            throw new ScmError(0, `${config.provider} unreachable: ${error instanceof Error ? error.message : String(error)}`);
        }
        const text = await response.text();
        if (!response.ok) {
            const hint = response.status === 401 || response.status === 403
                ? ` (check the token in ${config.tokenEnv ?? defaultTokenEnv(config.provider)})`
                : '';
            throw new ScmError(response.status, `${config.provider} ${method} ${path} -> ${String(response.status)}${hint}: ${scrub(text)}`);
        }
        return (text === '' ? {} : JSON.parse(text));
    };
    const view = (raw) => ({
        number: raw.number,
        url: raw.html_url,
        title: raw.title,
        state: raw.merged === true || (raw.merged_at !== undefined && raw.merged_at !== null) ? 'merged' : raw.state === 'open' ? 'open' : 'closed',
        head: raw.head.ref,
        base: raw.base.ref,
        headSha: raw.head.sha,
        ...raw.mergeable === true || raw.mergeable === false ? { mergeable: raw.mergeable } : {},
        draft: raw.draft === true,
    });
    return {
        provider: config.provider,
        repo: config.repo,
        async defaultBranch() {
            if (config.defaultBranch !== undefined)
                return config.defaultBranch;
            const repo = await call('GET', repoPath);
            return repo.default_branch ?? 'main';
        },
        async findOpen(branch) {
            const owner = config.repo.split('/')[0];
            const list = github
                ? await call('GET', `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
                : await call('GET', `${repoPath}/pulls?state=open&limit=50`);
            const hit = list.find(pull => pull.head.ref === branch);
            return hit === undefined ? undefined : view(hit);
        },
        async get(number) {
            return view(await call('GET', `${repoPath}/pulls/${String(number)}`));
        },
        async open(input) {
            return view(await call('POST', `${repoPath}/pulls`, {
                head: input.head, base: input.base, title: input.title, body: input.body,
                ...github && input.draft === true ? { draft: true } : {},
            }));
        },
        async update(number, input) {
            return view(await call('PATCH', `${repoPath}/pulls/${String(number)}`, input));
        },
        async checks(sha) {
            const failing = [];
            const pending = [];
            let total = 0;
            if (github) {
                const runs = await call('GET', `${repoPath}/commits/${sha}/check-runs?per_page=100`);
                for (const run of runs.check_runs ?? []) {
                    total += 1;
                    if (run.status !== 'completed')
                        pending.push(run.name);
                    else if (!['success', 'neutral', 'skipped'].includes(run.conclusion ?? ''))
                        failing.push(run.name);
                }
            }
            // Commit statuses: GitHub's older API and Gitea's (Actions report here too).
            const combined = await call('GET', `${repoPath}/commits/${sha}/status`).catch(() => ({ statuses: [] }));
            for (const status of combined.statuses ?? []) {
                total += 1;
                const state = status.state ?? status.status ?? '';
                if (state === 'pending' || state === 'running' || state === 'waiting')
                    pending.push(status.context);
                else if (state !== 'success')
                    failing.push(status.context);
            }
            const state = total === 0 ? 'none' : failing.length > 0 ? 'failure' : pending.length > 0 ? 'pending' : 'success';
            return { state, total, failing, pending };
        },
        async merge(number, method, sha) {
            if (github) {
                const out = await call('PUT', `${repoPath}/pulls/${String(number)}/merge`, {
                    merge_method: method, ...sha === undefined ? {} : { sha },
                });
                return { merged: out.merged === true, message: out.message ?? '' };
            }
            await call('POST', `${repoPath}/pulls/${String(number)}/merge`, {
                Do: method, ...sha === undefined ? {} : { head_commit_id: sha },
            });
            return { merged: true, message: 'merged' };
        },
    };
}
//# sourceMappingURL=scm.js.map