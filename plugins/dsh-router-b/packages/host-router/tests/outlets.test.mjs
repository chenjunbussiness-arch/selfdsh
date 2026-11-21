/**
 * Outlets (code host, server commands, headless browser), the approval queue
 * and audit log, 改派/换模型, batch actions and live output.
 *
 * Everything runs against temp directories, a real local git repository with a
 * bare remote, and a fake code host (`scmFetch`), so no network is touched.
 * POSIX only (git, sh); skipped on Windows.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { apply } from '../lib/index.js'
import { TaskBoard } from '../lib/board.js'
import { classifyCommand, hostAllowed, OutletStore } from '../lib/outlets.js'
import { createScmClient, scmProblem } from '../lib/scm.js'
import { liveSegments } from '../lib/live.js'

const posix = process.platform !== 'win32'
const tempDirs = []
const scratch = (prefix = 'host-router-outlets-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }) })

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// --- unit: command levels, allowlist, config --------------------------------

test('classifyCommand: reads run, changes are logged, dangerous ones ask', () => {
  for (const command of [
    'ls -la /var/log', 'tail -n 200 /var/log/nginx/error.log | grep -i timeout', 'systemctl status nginx',
    'journalctl -u nginx --since today', 'df -h && free -m', 'nginx -t', 'curl -I https://example.com',
    'docker ps', 'git status', 'openssl x509 -in cert.pem -noout -dates', 'ffprobe in.mp4 2>&1',
  ]) assert.equal(classifyCommand(command), 'read', command)

  for (const command of [
    'nginx -s reload', 'systemctl reload nginx', 'cp a b', 'echo hi > out.txt', 'sudo ls',
    'curl -X POST https://example.com/hook', 'curl -o file https://example.com/x', 'ffmpeg -i a.mp4 b.mp4',
    'ls $(pwd)', 'docker run --rm alpine true', 'git commit -m x',
  ]) assert.equal(classifyCommand(command), 'change', command)

  for (const command of [
    'rm -rf /srv/site/old', 'sudo rm a.txt', 'systemctl restart nginx', 'reboot', 'kill -9 1234',
    'cd x && rm -r build', 'docker compose down', 'git push --force origin main', 'ufw deny 22',
    'echo x > /etc/hosts', 'find . -name "*.tmp" -delete', 'mkfs.ext4 /dev/sdb1', 'DROP TABLE users',
  ]) assert.equal(classifyCommand(command), 'danger', command)

  // A partition's own list makes more commands dangerous.
  assert.equal(classifyCommand('rclone sync media remote:media'), 'change')
  assert.equal(classifyCommand('rclone sync media remote:media', ['^rclone sync']), 'danger')
  // A broken pattern is ignored, not thrown.
  assert.equal(classifyCommand('ls', ['(']), 'read')
})

test('hostAllowed: no list allows all; exact names and *.domain wildcards', () => {
  assert.equal(hostAllowed('anything.test', undefined), true)
  assert.equal(hostAllowed('anything.test', []), true)
  assert.equal(hostAllowed('example.com', ['example.com']), true)
  assert.equal(hostAllowed('www.example.com', ['example.com']), false)
  assert.equal(hostAllowed('www.example.com', ['*.example.com']), true)
  assert.equal(hostAllowed('example.com', ['*.example.com']), true)
  assert.equal(hostAllowed('badexample.com', ['*.example.com']), false)
  assert.equal(hostAllowed('EXAMPLE.com', ['example.COM']), true)
})

test('scmProblem validates the code host block', () => {
  assert.equal(scmProblem({ provider: 'github', repo: 'o/r' }), undefined)
  assert.equal(scmProblem({ provider: 'gitea', repo: 'o/r', baseUrl: 'https://git.example.com' }), undefined)
  assert.match(scmProblem({ provider: 'gitlab', repo: 'o/r' }), /provider/)
  assert.match(scmProblem({ provider: 'github', repo: 'nope' }), /owner\/name/)
  assert.match(scmProblem({ provider: 'gitea', repo: 'o/r' }), /baseUrl is required/)
  assert.match(scmProblem({ provider: 'github', repo: 'o/r', tokenEnv: 'lower-case' }), /tokenEnv/)
})

// --- unit: code host adapters -----------------------------------------------

/** A fetch that answers from a route table and records every call. */
function recorder(routes) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) })
    for (const [match, answer] of routes) {
      if (match(url, init.method)) {
        const out = typeof answer === 'function' ? answer(url, init) : answer
        const status = out.status ?? 200
        return { ok: status < 400, status, text: async () => out.raw ?? JSON.stringify(out.json ?? {}) }
      }
    }
    return { ok: false, status: 404, text: async () => '{"message":"Not Found"}' }
  }
  return { fetch, calls }
}

const rawPull = (number, extra = {}) => ({
  number, html_url: `https://code.example/o/r/pull/${String(number)}`, title: 'Add page', state: 'open',
  head: { ref: 'feature', sha: 'a'.repeat(40) }, base: { ref: 'main' }, mergeable: true, draft: false, ...extra,
})

test('GitHub adapter: bearer token, head filter, checks and merge with the approved sha', async () => {
  const { fetch, calls } = recorder([
    [(url, method) => method === 'GET' && url.endsWith('/repos/o/r'), { json: { default_branch: 'main' } }],
    [(url, method) => method === 'GET' && url.includes('/pulls?state=open'), { json: [rawPull(3)] }],
    [(url, method) => method === 'GET' && url.includes('/check-runs'), { json: { check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success' },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'e2e', status: 'in_progress', conclusion: null },
    ] } }],
    [(url, method) => method === 'GET' && url.endsWith('/status'), { json: { statuses: [{ context: 'deploy', state: 'success' }] } }],
    [(url, method) => method === 'PUT' && url.endsWith('/pulls/3/merge'), { json: { merged: true, message: 'ok' } }],
  ])
  const client = createScmClient({ provider: 'github', repo: 'o/r' }, () => 'ghp_secretvalue', fetch)
  assert.equal(await client.defaultBranch(), 'main')
  const pr = await client.findOpen('feature')
  assert.equal(pr.number, 3)
  assert.equal(pr.state, 'open')
  assert.match(calls[1].url, /^https:\/\/api\.github\.com\/repos\/o\/r\/pulls\?state=open&head=o%3Afeature$/)
  assert.equal(calls[1].headers.authorization, 'Bearer ghp_secretvalue')
  const checks = await client.checks(pr.headSha)
  assert.deepEqual(checks, { state: 'failure', total: 4, failing: ['lint'], pending: ['e2e'] })
  assert.deepEqual(await client.merge(3, 'squash', pr.headSha), { merged: true, message: 'ok' })
  assert.deepEqual(calls.at(-1).body, { merge_method: 'squash', sha: pr.headSha })
})

test('Gitea adapter: /api/v1, token header, statuses, Do merge; errors never carry the token', async () => {
  const { fetch, calls } = recorder([
    [(url, method) => method === 'GET' && url.includes('/pulls?state=open'), { json: [rawPull(9, { head: { ref: 'other', sha: 'b'.repeat(40) } }), rawPull(10)] }],
    [(url, method) => method === 'GET' && url.endsWith('/status'), { json: { statuses: [{ context: 'ci', status: 'pending' }] } }],
    [(url, method) => method === 'POST' && url.endsWith('/pulls/10/merge'), { status: 200, raw: '' }],
    [(url, method) => method === 'POST' && url.endsWith('/pulls'), { status: 403, raw: '{"message":"bad token ghp_leakedvalue12345","authorization":"token abc"}' }],
  ])
  const client = createScmClient({ provider: 'gitea', repo: 'o/r', baseUrl: 'https://git.example.com/' }, () => 'giteasecret', fetch)
  const pr = await client.findOpen('feature')
  assert.equal(pr.number, 10, 'filters by head ref client-side')
  assert.equal(calls[0].url, 'https://git.example.com/api/v1/repos/o/r/pulls?state=open&limit=50')
  assert.equal(calls[0].headers.authorization, 'token giteasecret')
  assert.deepEqual(await client.checks('x'), { state: 'pending', total: 1, failing: [], pending: ['ci'] })
  assert.deepEqual(await client.merge(10, 'merge', 'c'.repeat(40)), { merged: true, message: 'merged' })
  assert.deepEqual(calls.at(-1).body, { Do: 'merge', head_commit_id: 'c'.repeat(40) })
  await assert.rejects(client.open({ head: 'feature', base: 'main', title: 't', body: '' }), (error) => {
    assert.equal(error.status, 403)
    assert.match(error.message, /check the token in GITEA_TOKEN/)
    assert.doesNotMatch(error.message, /ghp_leakedvalue12345|giteasecret|token abc/)
    return true
  })
})

// --- unit: approval store and live segments ---------------------------------

test('OutletStore: queue survives a reopen, audits asks, expires stale items', async () => {
  const dir = scratch()
  const store = await OutletStore.open(dir)
  const one = await store.request({ kind: 'ops', partition: 'front', action: '危险命令', target: 'reboot', reason: 'r', reversible: false, params: { command: 'reboot' } })
  assert.equal(one.state, 'pending')
  const again = await OutletStore.open(dir)
  assert.equal(again.pending().length, 1)
  assert.equal(again.get(one.id).target, 'reboot')
  const audit = await again.recentAudit(10)
  assert.equal(audit.length, 1)
  assert.equal(audit[0].outcome, 'asked')
  // Age it past the TTL.
  const file = join(dir, 'approvals.json')
  const doc = JSON.parse(readFileSync(file, 'utf8'))
  doc.items[0].createdAt = new Date(Date.now() - 25 * 3600_000).toISOString()
  writeFileSync(file, JSON.stringify(doc))
  const old = await OutletStore.open(dir)
  await old.expire()
  assert.equal(old.get(one.id).state, 'expired')
  assert.equal(old.pending().length, 0)
})

test('liveSegments pairs calls with results, flags failures, and pages by seq', () => {
  const events = [
    { seq: 1, time: 1, type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: 'checking nginx' }] } } },
    { seq: 2, time: 2, type: 'tool/call', data: { id: 'c1', name: 'bash', arguments: { command: 'nginx -t' } } },
    { seq: 3, time: 3, type: 'tool/result', data: { id: 'c1', output: [{ type: 'text', text: 'syntax is ok' }] } },
    { seq: 4, time: 4, type: 'tool/call', data: { id: 'c2', name: 'bash', arguments: { command: 'cat /nope' } } },
    { seq: 5, time: 5, type: 'tool/result', data: { id: 'c2', output: [{ type: 'text', text: 'cat: /nope: No such file or directory' }] } },
    { seq: 6, time: 6, type: 'tool/call', data: { id: 'c3', name: 'bash', arguments: { command: 'sleep 100' } } },
  ]
  const all = liveSegments(events)
  assert.deepEqual(all.map(segment => [segment.seq, segment.kind, segment.title, segment.error, segment.running === true]), [
    [1, 'message', 'assistant', false, false],
    [2, 'command', 'bash: nginx -t', false, false],
    [4, 'command', 'bash: cat /nope', true, false],
    [6, 'command', 'bash: sleep 100', false, true],
  ])
  assert.equal(all[1].body, 'syntax is ok')
  // After seq 4 only the newer segment, plus whatever still runs.
  assert.deepEqual(liveSegments(events, 4).map(segment => segment.seq), [6])
  assert.deepEqual(liveSegments([...events, { seq: 7, time: 7, type: 'turn/end', data: { reason: { kind: 'error' } } }], 6).map(segment => [segment.seq, segment.error]), [[6, false], [7, true]])
})

// --- integration harness -----------------------------------------------------

const fakeAgent = id => ({ id, session: { id, header: { id, cwd: '/w' } } })

function harness() {
  const tools = new Map()
  const starts = []
  const sent = []
  const activations = []
  const interrupted = []
  const agents = new Map()
  const routes = []
  const logs = new Map()
  const ctx = {
    tools: { register(d) { tools.set(d.name, d); return () => tools.delete(d.name) } },
    logger: { info() {}, warn() {} },
    on() { return () => {} },
    effect(run) { return run() },
    inject(deps, callback) {
      callback({ ...ctx, webServer: { register(route) { routes.push(route); return () => {} } } })
      return () => {}
    },
    get(name) {
      if (name === 'agents') return { get: id => agents.get(id), async create() { throw new Error('no create in test') } }
      if (name === 'sessionQuery') return { async readSession(id) { return { session: { id }, events: logs.get(id) ?? [] } }, async listSessions() { return [] } }
      if (name === 'subagents') {
        return {
          async startActivation(spec) {
            starts.push(spec)
            let settle
            const result = new Promise((resolve) => { settle = resolve })
            const activation = { childId: `child-${String(activations.length + 1)}`, name: `agent-${String(activations.length + 1)}`, result, async dispose() {}, settle }
            activations.push(activation)
            return activation
          },
          async sendMessage(sender, targetId, content) { sent.push({ sender: sender.id, targetId, text: content[0]?.text }); return `msg-${String(sent.length)}` },
          interrupt(targetId) { interrupted.push(targetId) },
        }
      }
      return undefined
    },
  }
  return { ctx, tools, starts, sent, activations, interrupted, agents, routes, logs }
}

/** Drive one bridge route with a fake exchange; returns {status, json}. */
async function http(h, path, { method = 'GET', body, url } = {}) {
  const route = h.routes.find(entry => entry.path === `/api/router/${path}`)
  assert.ok(route, `route ${path} is registered`)
  let status
  let text = ''
  const res = {
    headersSent: false, writableEnded: false,
    writeHead(code) { status = code; res.headersSent = true; return res },
    setHeader() {}, write(chunk) { text += String(chunk); return true },
    end(chunk) { if (chunk !== undefined) text += String(chunk); res.writableEnded = true; return res },
    on() { return res }, destroy() {},
  }
  const req = {
    method, url: url ?? `/api/router/${path}`,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    on() { return req }, destroy() {},
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  await route.handler(req, res)
  return { status, json: text === '' ? undefined : JSON.parse(text) }
}

async function waitFor(check, label, timeoutMs = 4000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`timed out waiting for ${label}`)
}

const exec = agent => ({ agent, signal: new AbortController().signal })
const done = text => ({ stopReason: 'completed', output: [{ type: 'text', text }] })

/** A fake GitHub holding pull requests in memory. */
function fakeGitHub() {
  const pulls = []
  const merged = []
  let headSha = 'a'.repeat(40)
  const routes = [
    [(url, method) => method === 'GET' && url.endsWith('/repos/o/r'), () => ({ json: { default_branch: 'main' } })],
    [(url, method) => method === 'GET' && url.includes('/pulls?state=open'), (url) => {
      const head = decodeURIComponent(url.split('head=')[1] ?? '').split(':')[1]
      return { json: pulls.filter(pull => pull.state === 'open' && pull.head.ref === head) }
    }],
    [(url, method) => method === 'POST' && url.endsWith('/repos/o/r/pulls'), (url, init) => {
      const body = JSON.parse(init.body)
      const pull = { ...rawPull(pulls.length + 41), title: body.title, head: { ref: body.head, sha: headSha }, base: { ref: body.base } }
      pulls.push(pull)
      return { status: 201, json: pull }
    }],
    [(url, method) => method === 'PATCH' && /\/pulls\/\d+$/.test(url), (url, init) => {
      const pull = pulls.find(entry => url.endsWith(`/pulls/${String(entry.number)}`))
      Object.assign(pull, JSON.parse(init.body))
      return { json: pull }
    }],
    [(url, method) => method === 'GET' && /\/pulls\/\d+$/.test(url), (url) => {
      const pull = pulls.find(entry => url.endsWith(`/pulls/${String(entry.number)}`))
      return pull === undefined ? { status: 404, json: { message: 'Not Found' } } : { json: { ...pull, head: { ...pull.head, sha: headSha } } }
    }],
    [(url, method) => method === 'GET' && url.includes('/check-runs'), () => ({ json: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] } })],
    [(url, method) => method === 'GET' && url.endsWith('/status'), () => ({ json: { statuses: [] } })],
    [(url, method) => method === 'PUT' && url.endsWith('/merge'), (url, init) => {
      const number = Number(url.split('/pulls/')[1].split('/')[0])
      merged.push({ number, ...JSON.parse(init.body) })
      const pull = pulls.find(entry => entry.number === number)
      pull.state = 'closed'
      pull.merged = true
      return { json: { merged: true, message: 'Pull Request successfully merged' } }
    }],
  ]
  const { fetch, calls } = recorder(routes)
  return { fetch, calls, pulls, merged, setHead(sha) { headSha = sha } }
}

/** A checkout on branch `feature` with a bare `origin`, plus a router over it. */
async function boot({ outlets, manager = false, extraPartitions = [] } = {}) {
  const dir = scratch()
  const remote = join(dir, 'remote.git')
  const root = join(dir, 'site')
  git(dir, 'init', '--bare', '-b', 'main', remote)
  git(dir, 'clone', remote, root)
  git(root, 'config', 'user.email', 'router@example.invalid')
  git(root, 'config', 'user.name', 'router test')
  git(root, 'checkout', '-b', 'main')
  writeFileSync(join(root, 'README.md'), 'site\n')
  git(root, 'add', 'README.md')
  git(root, 'commit', '-m', 'init')
  git(root, 'push', '-u', 'origin', 'main')
  git(root, 'checkout', '-b', 'feature')
  for (const extra of extraPartitions) mkdirSync(join(dir, extra), { recursive: true })

  const shotLog = join(dir, 'shots.log')
  const shot = join(dir, 'screenshot.sh')
  writeFileSync(shot, `#!/bin/sh\necho "$@" >> '${shotLog}'\nprintf 'PNG' > "$2"\n`)
  chmodSync(shot, 0o755)

  const host = fakeGitHub()
  const h = harness()
  const user = fakeAgent('root')
  h.agents.set('root', user)
  await apply(h.ctx, {
    boardDir: join(dir, 'board'), manager, resumeDelayMs: 60_000, progressNoticeDelayMs: 10,
    screenshotCommand: shot,
    scmFetch: host.fetch,
    partitions: [
      { name: 'site', root, workers: 0, git: { scm: { provider: 'github', repo: 'o/r' } }, ...outlets === undefined ? {} : { outlets } },
      ...extraPartitions.map(name => ({ name, root: join(dir, name), workers: 0 })),
    ],
  })
  const call = (name, args, agent = user) => h.tools.get(name).execute(args, exec(agent))
  const board = async () => TaskBoard.open(join(dir, 'board'))
  /** Publish a task and return it with its worker agent. */
  const work = async (text, partition = 'site') => {
    const id = (await call('route_task', { text, partition })).task
    const row = (await board()).get(id)
    const worker = fakeAgent(row.sessionId)
    h.agents.set(row.sessionId, worker)
    return { id, worker, sessionId: row.sessionId }
  }
  const auditLines = () => {
    const auditDir = join(dir, 'board', 'audit')
    return readdirSync(auditDir).flatMap(name => readFileSync(join(auditDir, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
  }
  return { dir, root, remote, h, user, call, board, work, host, shotLog, auditLines }
}

// --- integration: code outlet ------------------------------------------------

test('git_publish commits the named paths, pushes the branch, opens a PR and writes it on the row', { skip: !posix }, async () => {
  const { root, remote, call, board, work, host, auditLines } = await boot()
  const { id, worker } = await work('add a subscribe page')
  writeFileSync(join(root, 'subscribe.html'), '<h1>subscribe</h1>\n')
  writeFileSync(join(root, 'scratch.txt'), 'not mine\n')

  const out = await call('git_publish', { commit_message: 'Add subscribe page', paths: ['subscribe.html'], title: 'Subscribe page', body: 'adds it' }, worker)
  assert.match(out.text, /pushed feature to origin; opened PR #41 -> main/)
  assert.match(out.text, /1 uncommitted path\(s\) stay local/)
  assert.equal(git(remote, 'log', '-1', '--format=%s', 'feature'), 'Add subscribe page')
  assert.equal(git(remote, 'show', '--name-only', '--format=', 'feature'), 'subscribe.html', 'only the named path is committed')
  assert.equal(host.pulls.length, 1)
  assert.equal(host.pulls[0].title, 'Subscribe page')
  assert.equal(host.calls.find(c => c.method === 'POST').body.base, 'main')
  assert.deepEqual((await board()).get(id).pr, { number: 41, url: 'https://code.example/o/r/pull/41', provider: 'github' })

  // A second publish updates the same PR instead of opening another.
  const again = await call('git_publish', { title: 'Subscribe page v2' }, worker)
  assert.match(again.text, /updated PR #41/)
  assert.equal(host.pulls.length, 1)
  assert.equal(host.pulls[0].title, 'Subscribe page v2')
  assert.ok(auditLines().some(line => line.kind === 'git' && line.outcome === 'ran' && line.taskId === id))

  // Paths that escape the checkout are refused before git runs.
  await assert.rejects(call('git_publish', { commit_message: 'x', paths: ['../etc/passwd'] }, worker), /stay inside it/)
  await assert.rejects(call('git_publish', { commit_message: 'x' }, worker), /needs the paths/)
})

test('git_publish refuses the default branch', { skip: !posix }, async () => {
  const { root, call, work } = await boot()
  const { worker } = await work('hotfix')
  git(root, 'checkout', 'main')
  await assert.rejects(call('git_publish', {}, worker), /main/)
})

test('pr_merge only files an approval; 同意 merges the approved head and tells the worker', { skip: !posix }, async () => {
  const { call, work, host, h, auditLines } = await boot()
  const { id, worker, sessionId } = await work('ship the page')
  await call('git_publish', { title: 'Ship' }, worker)

  const status = await call('pr_status', {}, worker)
  assert.match(status.text, /PR #41 open: Ship/)
  assert.match(status.text, /checks: success \(1\)/)

  const asked = await call('pr_merge', { number: 41, reason: 'checks green' }, worker)
  assert.match(asked.text, /需要人工确认：已提交确认单 ap-/)
  assert.equal(host.merged.length, 0, 'nothing merged yet')
  const list = await http(h, 'approvals')
  assert.equal(list.status, 200)
  assert.equal(list.json.pending.length, 1)
  const card = list.json.pending[0]
  assert.equal(card.kind, 'merge')
  assert.equal(card.taskId, id)
  assert.equal(card.reversible, false)
  assert.match(card.action, /合并 PR #41「Ship」到 main（squash）/)
  assert.match(card.reason, /checks green\nCI：success/)

  const decided = await http(h, 'approvals', { method: 'POST', body: { id: card.id, decision: 'approve' } })
  assert.equal(decided.status, 200)
  assert.equal(decided.json.state, 'done')
  assert.match(decided.json.result, /merged PR #41 \(squash\) into main/)
  assert.deepEqual(host.merged, [{ number: 41, merge_method: 'squash', sha: 'a'.repeat(40) }])
  const told = h.sent.find(message => message.targetId === sessionId)
  assert.ok(told, 'the worker is told')
  assert.match(told.text, new RegExp(`确认单 ${card.id} 已获用户同意并执行`))
  assert.deepEqual(auditLines().filter(line => line.kind === 'merge').map(line => line.outcome), ['asked', 'approved', 'ran'])

  // A decided approval cannot be decided again.
  const twice = await http(h, 'approvals', { method: 'POST', body: { id: card.id, decision: 'approve' } })
  assert.equal(twice.status, 409)
})

test('a push after approval voids the merge; 拒绝 merges nothing and says so', { skip: !posix }, async () => {
  const { call, work, host, h } = await boot()
  const { worker, sessionId } = await work('ship again')
  await call('git_publish', { title: 'Ship' }, worker)

  await call('pr_merge', { number: 41, reason: 'ready' }, worker)
  let card = (await http(h, 'approvals')).json.pending[0]
  host.setHead('b'.repeat(40))
  const moved = await http(h, 'approvals', { method: 'POST', body: { id: card.id, decision: 'approve' } })
  assert.equal(moved.json.state, 'failed')
  assert.match(moved.json.result, /changed after it was approved/)
  assert.equal(host.merged.length, 0)

  await call('pr_merge', { number: 41, reason: 'ready now' }, worker)
  card = (await http(h, 'approvals')).json.pending[0]
  const refused = await http(h, 'approvals', { method: 'POST', body: { id: card.id, decision: 'reject', note: '先别合' } })
  assert.equal(refused.json.state, 'rejected')
  assert.equal(host.merged.length, 0)
  assert.ok(h.sent.some(message => message.targetId === sessionId && /用户拒绝了确认单.*先别合/.test(message.text)))
  assert.equal((await http(h, 'approvals')).json.pending.length, 0)
  assert.equal((await http(h, 'approvals', { method: 'POST', body: { id: 'ap-none', decision: 'approve' } })).status, 404)
  assert.equal((await http(h, 'approvals', { method: 'POST', body: { id: card.id, decision: 'maybe' } })).status, 400)
})

test('git publishing in confirm mode waits for 同意, and off refuses', { skip: !posix }, async () => {
  const confirm = await boot({ outlets: { git: 'confirm' } })
  const { worker } = await confirm.work('publish carefully')
  const asked = await confirm.call('git_publish', { title: 'Careful' }, worker)
  assert.match(asked.text, /需要人工确认/)
  assert.equal(confirm.host.pulls.length, 0)
  const card = (await http(confirm.h, 'approvals')).json.pending[0]
  assert.equal(card.kind, 'git')
  const ran = await http(confirm.h, 'approvals', { method: 'POST', body: { id: card.id, decision: 'approve' } })
  assert.equal(ran.json.state, 'done')
  assert.equal(confirm.host.pulls.length, 1)

  const off = await boot({ outlets: { git: 'off' } })
  const other = await off.work('publish')
  await assert.rejects(off.call('git_publish', {}, other.worker), /git publishing is off/)
})

// --- integration: server commands -------------------------------------------

test('ops_run: reads and changes run and are audited; danger waits and runs once on 同意', { skip: !posix }, async () => {
  const { root, call, work, h, auditLines } = await boot()
  const { id, worker } = await work('check the site')

  const read = await call('ops_run', { command: 'ls', reason: 'look' }, worker)
  assert.match(read.text, /^\[read\] exit 0\nREADME.md/)
  const change = await call('ops_run', { command: 'touch made.txt', reason: 'mark' }, worker)
  assert.match(change.text, /^\[change\] exit 0/)
  assert.equal(existsSync(join(root, 'made.txt')), true)

  const danger = await call('ops_run', { command: 'rm made.txt', reason: 'clean up' }, worker)
  assert.match(danger.text, /^\[danger\] 需要人工确认/)
  assert.equal(existsSync(join(root, 'made.txt')), true, 'not run yet')
  const card = (await http(h, 'approvals')).json.pending[0]
  assert.equal(card.target, 'rm made.txt')
  assert.equal(card.reversible, false)
  const ran = await http(h, 'approvals', { method: 'POST', body: { id: card.id, decision: 'approve' } })
  assert.equal(ran.json.state, 'done')
  assert.equal(existsSync(join(root, 'made.txt')), false)

  const lines = auditLines().filter(line => line.kind === 'ops')
  assert.deepEqual(lines.map(line => [line.outcome, line.by]), [['ran', 'agent'], ['ran', 'agent'], ['asked', 'agent'], ['approved', 'human'], ['ran', 'router']])
  assert.ok(lines.every(line => line.taskId === id))
  const audit = await http(h, 'audit', { url: '/api/router/audit?limit=2' })
  assert.equal(audit.json.entries.length, 2)
})

test('ops_run in confirm mode asks for changes but still runs reads; a partition danger list applies', { skip: !posix }, async () => {
  const { call, work, h } = await boot({ outlets: { ops: 'confirm', danger: ['^rclone sync'] } })
  const { worker } = await work('media sync')
  assert.match((await call('ops_run', { command: 'pwd', reason: 'where' }, worker)).text, /^\[read\] exit 0/)
  assert.match((await call('ops_run', { command: 'touch x', reason: 'mark' }, worker)).text, /^\[change\] 需要人工确认/)
  assert.match((await call('ops_run', { command: 'rclone sync media remote:', reason: 'publish' }, worker)).text, /^\[danger\] 需要人工确认/)
  assert.equal((await http(h, 'approvals')).json.pending.length, 2)
})

// --- integration: browser ----------------------------------------------------

test('browser_capture saves a screenshot under the task artifacts and honours the allowlist', { skip: !posix }, async () => {
  const { root, call, work, shotLog, auditLines } = await boot({ outlets: { browserAllow: ['*.example.com'] } })
  const { id, worker } = await work('check the home page')
  const out = await call('browser_capture', { url: 'https://www.example.com/', full: true }, worker)
  assert.match(out.text, new RegExp(`\\.dsh-artifacts/${id}/shot-.*\\.png$`))
  assert.equal(readFileSync(out.text, 'utf8'), 'PNG')
  assert.ok(out.text.startsWith(root))
  assert.match(readFileSync(shotLog, 'utf8'), /^https:\/\/www\.example\.com\/ .* --full$/m)
  assert.ok(auditLines().some(line => line.kind === 'browser' && line.outcome === 'ran'))

  await assert.rejects(call('browser_capture', { url: 'https://elsewhere.test/' }, worker), /not in this partition's browser allowlist/)
  await assert.rejects(call('browser_capture', { url: 'file:///etc/passwd' }, worker), /only http\(s\)/)
})

// --- integration: 改派 / 换模型 ------------------------------------------------

test('reassign with keep-progress carries the work so far, rewires dependents and tells the manager', { skip: !posix }, async () => {
  const { h, call, board } = await boot({ manager: true, extraPartitions: ['media'] })
  const m = (await call('route_task', { text: 'feature', partition: 'site' })).task
  const mgr = fakeAgent('child-1')
  h.agents.set('child-1', mgr)
  const one = (await call('route_task', { text: 'transcode the clips', partition: 'site', parent_task: m }, mgr)).task
  const two = (await call('route_task', { text: 'upload them', partition: 'site', parent_task: m, depends_on: [one] }, mgr)).task
  const oneRow = (await board()).get(one)
  h.logs.set(oneRow.sessionId, [
    { seq: 1, time: 1, type: 'tool/call', data: { id: 'c1', name: 'bash', arguments: { command: 'ffmpeg -i a.mp4 a.webm' } } },
    { seq: 2, time: 2, type: 'tool/result', data: { id: 'c1', output: [{ type: 'text', text: 'ffmpeg: codec not found' }] } },
  ])

  const out = await http(h, 'reassign', { method: 'POST', body: { taskId: one, partition: 'media', note: '这台机器没有编码器' } })
  assert.equal(out.status, 200)
  const to = out.json.to
  assert.equal(out.json.partition, 'media')
  const rows = await board()
  assert.equal(rows.get(one).state, 'cancelled')
  assert.equal(rows.get(one).reassignedTo, to)
  const fresh = rows.get(to)
  assert.equal(fresh.reassignedFrom, one)
  assert.equal(fresh.partition, 'media')
  assert.equal(fresh.parentId, m)
  assert.match(fresh.body, /transcode the clips/)
  assert.match(fresh.body, /改派说明（原任务 /)
  assert.match(fresh.body, /原因：这台机器没有编码器/)
  assert.match(fresh.body, /ffmpeg: codec not found/)
  assert.match(fresh.body, /接着它的进度继续/)
  assert.deepEqual(rows.get(two).dependsOn, [to], 'dependents now wait on the new row')
  assert.ok(h.sent.some(message => message.targetId === 'child-1' && message.text.includes(`被改派为 ${to}`)))
  assert.ok(h.interrupted.includes(oneRow.sessionId))

  // A row can only be reassigned once.
  assert.equal((await http(h, 'reassign', { method: 'POST', body: { taskId: one, partition: 'media' } })).status, 409)
})

test('reassign from scratch onto another model records the override; a same-place retry is refused', { skip: !posix }, async () => {
  const { h, call, board } = await boot()
  const { id } = await work0(call, board, h)
  // Same partition, same model, from scratch is a retry.
  assert.equal((await http(h, 'reassign', { method: 'POST', body: { taskId: id, keepProgress: false } })).status, 409)
  const out = await call('task_reassign', { task_id: id, provider: 'acme', model: 'big-1', keep_progress: false })
  assert.match(out.text, /reassigned .*（site \/ big-1，从头来）/)
  const rows = await board()
  const to = rows.get(id).reassignedTo
  assert.deepEqual(rows.get(to).routeOverride, { provider: 'acme', model: 'big-1' })
  assert.match(rows.get(to).body, /从头开始做/)
  assert.doesNotMatch(rows.get(to).body, /接着它的进度继续/)
  const spec = h.starts.at(-1)
  assert.ok(JSON.stringify(spec).includes('big-1'), 'the new worker runs on the chosen model')
  await assert.rejects(call('task_reassign', { task_id: to, model: 'x' }), /provider and model together/)
})

async function work0(call, board, h) {
  const id = (await call('route_task', { text: 'make the banner', partition: 'site' })).task
  const row = (await board()).get(id)
  h.agents.set(row.sessionId, fakeAgent(row.sessionId))
  return { id }
}

// --- integration: batch and live --------------------------------------------

test('batch applies one action per row and reports each outcome', { skip: !posix }, async () => {
  const { h, call, board } = await boot()
  const a = (await call('route_task', { text: 'one', partition: 'site' })).task
  const b = (await call('route_task', { text: 'two', partition: 'site' })).task
  h.activations[0].settle(done('ok'))
  await waitFor(async () => ['done', 'reported'].includes((await board()).get(a).state), 'a settled')

  const out = await http(h, 'batch', { method: 'POST', body: { taskIds: [a, b, b, 'T-missing'], action: 'cancel', value: '批量停止' } })
  assert.equal(out.status, 200)
  assert.equal(out.json.results.length, 3, 'duplicates collapse')
  const byId = Object.fromEntries(out.json.results.map(result => [result.id, result]))
  assert.equal(byId[b].ok, true)
  assert.equal((await board()).get(b).state, 'cancelled')
  assert.equal(byId['T-missing'].ok, false)
  assert.equal(out.json.ok + out.json.failed, 3)

  assert.equal((await http(h, 'batch', { method: 'POST', body: { taskIds: [a], action: 'explode' } })).status, 400)
  assert.equal((await http(h, 'batch', { method: 'POST', body: { taskIds: [], action: 'cancel' } })).status, 400)

  const retried = await http(h, 'batch', { method: 'POST', body: { taskIds: [b], action: 'retry' } })
  assert.equal(retried.json.ok, 1)
  assert.notEqual((await board()).get(b).state, 'cancelled')
})

test('live returns a running worker\'s output in segments, paged by seq', { skip: !posix }, async () => {
  const { h, call, board } = await boot()
  const id = (await call('route_task', { text: 'reload nginx', partition: 'site' })).task
  const { sessionId } = (await board()).get(id)
  h.logs.set(sessionId, [
    { seq: 1, time: 10, type: 'tool/call', data: { id: 'c1', name: 'bash', arguments: { command: 'nginx -t' } } },
    { seq: 2, time: 11, type: 'tool/result', data: { id: 'c1', output: [{ type: 'text', text: 'nginx: [emerg] unknown directive' }], isError: true } },
    { seq: 3, time: 12, type: 'tool/call', data: { id: 'c2', name: 'bash', arguments: { command: 'tail -f /var/log/nginx/error.log' } } },
  ])
  const first = await http(h, 'live', { url: `/api/router/live?taskId=${id}` })
  assert.equal(first.status, 200)
  assert.equal(first.json.sessionId, sessionId)
  assert.deepEqual(first.json.segments.map(segment => [segment.seq, segment.error, segment.running === true]), [[1, true, false], [3, false, true]])
  const next = await http(h, 'live', { url: `/api/router/live?taskId=${id}&after=3` })
  assert.deepEqual(next.json.segments.map(segment => segment.seq), [3], 'only the still-running command')
  assert.equal((await http(h, 'live', { url: '/api/router/live?taskId=T-nope' })).status, 404)
  assert.equal((await http(h, 'live', { url: '/api/router/live' })).status, 400)
})
