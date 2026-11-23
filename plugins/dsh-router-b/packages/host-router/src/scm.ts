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
export type ScmProvider = 'github' | 'gitea'

/** Code host settings of one partition (`git.scm` in the configuration). */
export interface ScmConfig {
  readonly provider: ScmProvider
  /** `owner/name`. */
  readonly repo: string
  /**
   * API base. GitHub defaults to `https://api.github.com`; Gitea needs its own,
   * for example `https://git.example.com` (the adapter adds `/api/v1`).
   */
  readonly baseUrl?: string
  /** Environment variable holding the token; defaults to `GITHUB_TOKEN` / `GITEA_TOKEN`. */
  readonly tokenEnv?: string
  /** Branch pull requests target; read from the host when absent. */
  readonly defaultBranch?: string
  /** Git remote to push to (default `origin`). */
  readonly remote?: string
}

/** A pull request as the router reports it. */
export interface PullView {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly state: 'open' | 'closed' | 'merged'
  readonly head: string
  readonly base: string
  readonly headSha: string
  /** `true`/`false` when the host knows, `undefined` while it is still computing. */
  readonly mergeable?: boolean
  readonly draft: boolean
}

/** Combined check result of one commit. */
export interface ChecksView {
  readonly state: 'success' | 'failure' | 'pending' | 'none'
  readonly total: number
  readonly failing: readonly string[]
  readonly pending: readonly string[]
}

/** What the router asks of a code host. */
export interface ScmClient {
  readonly provider: ScmProvider
  readonly repo: string
  defaultBranch(): Promise<string>
  /** The open pull request whose head is `branch`, if any. */
  findOpen(branch: string): Promise<PullView | undefined>
  get(number: number): Promise<PullView>
  open(input: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<PullView>
  update(number: number, input: { title?: string; body?: string }): Promise<PullView>
  checks(sha: string): Promise<ChecksView>
  merge(number: number, method: 'merge' | 'squash' | 'rebase', sha?: string): Promise<{ merged: boolean; message: string }>
}

/** Error from a code host; `status` is the HTTP status, 0 for a network failure. */
export class ScmError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ScmError'
  }
}

/** `fetch` as far as the adapters use it, so tests can pass a fake. */
export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Validate one `git.scm` block.
 * @returns the problem, or undefined when it is usable.
 */
export function scmProblem(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return 'git.scm must be an object'
  const scm = raw as Record<string, unknown>
  if (scm.provider !== 'github' && scm.provider !== 'gitea') return 'git.scm.provider must be "github" or "gitea"'
  if (typeof scm.repo !== 'string' || !REPO_RE.test(scm.repo)) return 'git.scm.repo must be "owner/name"'
  if (scm.provider === 'gitea' && (typeof scm.baseUrl !== 'string' || !/^https?:\/\//.test(scm.baseUrl))) {
    return 'git.scm.baseUrl is required for gitea (http(s)://…)'
  }
  if (scm.baseUrl !== undefined && (typeof scm.baseUrl !== 'string' || !/^https?:\/\//.test(scm.baseUrl))) {
    return 'git.scm.baseUrl must start with http:// or https://'
  }
  if (scm.tokenEnv !== undefined && (typeof scm.tokenEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(scm.tokenEnv))) {
    return 'git.scm.tokenEnv must be an environment variable name'
  }
  return undefined
}

/** Default token variable of a provider. */
export const defaultTokenEnv = (provider: ScmProvider): string => provider === 'github' ? 'GITHUB_TOKEN' : 'GITEA_TOKEN'

/** Read a token from the environment; never logged. */
export const envToken = (config: ScmConfig): string | undefined => {
  const value = process.env[config.tokenEnv ?? defaultTokenEnv(config.provider)]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/** Strip anything token-like from a host's error body before it is shown. */
const scrub = (text: string): string => text
  .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[token]')
  .replace(/(token|authorization)["':= ]+[^\s"',}]+/gi, '$1 [hidden]')
  .slice(0, 400)

/**
 * Build a client for one partition's repository.
 * @param config - the partition's `git.scm` block.
 * @param token - resolves the token at call time (undefined: anonymous reads only).
 * @param fetchImpl - `fetch`; injectable for tests.
 */
export function createScmClient(
  config: ScmConfig,
  token: () => string | undefined | Promise<string | undefined>,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): ScmClient {
  const github = config.provider === 'github'
  const root = github
    ? (config.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
    : `${(config.baseUrl ?? '').replace(/\/+$/, '')}/api/v1`
  const repoPath = `/repos/${config.repo}`

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const headers: Record<string, string> = {
      accept: github ? 'application/vnd.github+json' : 'application/json',
      'user-agent': 'dsh-router',
    }
    const secret = await token()
    if (secret !== undefined) headers.authorization = github ? `Bearer ${secret}` : `token ${secret}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let response
    try {
      response = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.timeout(20_000),
      })
    } catch (error) {
      throw new ScmError(0, `${config.provider} unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await response.text()
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? ` (check the token in ${config.tokenEnv ?? defaultTokenEnv(config.provider)})`
        : ''
      throw new ScmError(response.status, `${config.provider} ${method} ${path} -> ${String(response.status)}${hint}: ${scrub(text)}`)
    }
    return (text === '' ? {} : JSON.parse(text)) as T
  }

  type RawPull = {
    number: number; html_url: string; title: string; state: string; merged?: boolean; merged_at?: string | null
    head: { ref: string; sha: string }; base: { ref: string }; mergeable?: boolean | null; draft?: boolean
  }
  const view = (raw: RawPull): PullView => ({
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    state: raw.merged === true || (raw.merged_at !== undefined && raw.merged_at !== null) ? 'merged' : raw.state === 'open' ? 'open' : 'closed',
    head: raw.head.ref,
    base: raw.base.ref,
    headSha: raw.head.sha,
    ...raw.mergeable === true || raw.mergeable === false ? { mergeable: raw.mergeable } : {},
    draft: raw.draft === true,
  })

  return {
    provider: config.provider,
    repo: config.repo,
    async defaultBranch() {
      if (config.defaultBranch !== undefined) return config.defaultBranch
      const repo = await call<{ default_branch?: string }>('GET', repoPath)
      return repo.default_branch ?? 'main'
    },
    async findOpen(branch) {
      const owner = config.repo.split('/')[0]!
      const list = github
        ? await call<RawPull[]>('GET', `${repoPath}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
        : await call<RawPull[]>('GET', `${repoPath}/pulls?state=open&limit=50`)
      const hit = list.find(pull => pull.head.ref === branch)
      return hit === undefined ? undefined : view(hit)
    },
    async get(number) {
      return view(await call<RawPull>('GET', `${repoPath}/pulls/${String(number)}`))
    },
    async open(input) {
      return view(await call<RawPull>('POST', `${repoPath}/pulls`, {
        head: input.head, base: input.base, title: input.title, body: input.body,
        ...github && input.draft === true ? { draft: true } : {},
      }))
    },
    async update(number, input) {
      return view(await call<RawPull>('PATCH', `${repoPath}/pulls/${String(number)}`, input))
    },
    async checks(sha) {
      const failing: string[] = []
      const pending: string[] = []
      let total = 0
      if (github) {
        const runs = await call<{ check_runs?: { name: string; status: string; conclusion: string | null }[] }>(
          'GET', `${repoPath}/commits/${sha}/check-runs?per_page=100`)
        for (const run of runs.check_runs ?? []) {
          total += 1
          if (run.status !== 'completed') pending.push(run.name)
          else if (!['success', 'neutral', 'skipped'].includes(run.conclusion ?? '')) failing.push(run.name)
        }
      }
      // Commit statuses: GitHub's older API and Gitea's (Actions report here too).
      const combined = await call<{ statuses?: { context: string; state?: string; status?: string }[] }>(
        'GET', `${repoPath}/commits/${sha}/status`).catch(() => ({ statuses: [] }))
      for (const status of combined.statuses ?? []) {
        total += 1
        const state = status.state ?? status.status ?? ''
        if (state === 'pending' || state === 'running' || state === 'waiting') pending.push(status.context)
        else if (state !== 'success') failing.push(status.context)
      }
      const state = total === 0 ? 'none' : failing.length > 0 ? 'failure' : pending.length > 0 ? 'pending' : 'success'
      return { state, total, failing, pending }
    },
    async merge(number, method, sha) {
      if (github) {
        const out = await call<{ merged?: boolean; message?: string }>('PUT', `${repoPath}/pulls/${String(number)}/merge`, {
          merge_method: method, ...sha === undefined ? {} : { sha },
        })
        return { merged: out.merged === true, message: out.message ?? '' }
      }
      await call('POST', `${repoPath}/pulls/${String(number)}/merge`, {
        Do: method, ...sha === undefined ? {} : { head_commit_id: sha },
      })
      return { merged: true, message: 'merged' }
    },
  }
}
