/**
 * What an agent may do (`can`), pipelines (plan -> code -> test -> commit -> review with
 * bounces and the reviewer never being the author), daily quotas by tokens, and an
 * agent asking for a wider grant (regrant).
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { gist, verdictOf, pipelinesOf } from '../lib/pipeline.js'
import { quotaOf, usageOf } from '../lib/quota.js'
import { CTL, b64, expectHubError, makeHub, provision } from './helpers.mjs'

const file = (name, text = `${name}\n`) => ({ name, base64: b64(text) })
const DAY = 24 * 3600_000

/** Three agents the way the user wants them: planner/reviewer, coder that tests, local worker. */
async function crew(hub) {
  await provision(hub, 'cc', { can: ['plan', 'review', 'code'], workspaces: ['demo'] })
  await provision(hub, 'agy', { can: ['code', 'test'], workspaces: ['demo'] })
  await provision(hub, 'wk', { role: 'worker', workspaces: ['demo'] })
  for (const id of ['cc', 'agy', 'wk']) await hub.heartbeat(id, { workspaces: ['demo'] })
}

async function take(hub, agentId) {
  const { tasks } = await hub.poll(agentId)
  return tasks[0]
}

function feature(hub, extra = {}) {
  return hub.dispatch(CTL, { title: '加一个开关', instruction: '给设置页加一个深色模式开关。', pipeline: 'feature', workspace: 'demo', task_id: 'p1', verify: 'npm test', ...extra })
}

test('verdicts and templates', () => {
  assert.equal(gist('改了两个文件：\n1. calc.py\n\n2. test_calc.py\n别的没动'), '改了两个文件： 1. calc.py 2. test_calc.py 别的没动')
  assert.equal(gist('\n通过\n细节'), '通过')
  assert.equal(verdictOf('test', '通过 12 条'), 'pass')
  assert.equal(verdictOf('test', '不通过：1 条失败'), 'fail')
  assert.equal(verdictOf('review', '# 退回\n- 少了测试'), 'fail')
  assert.equal(verdictOf('review', 'LGTM'), 'pass')
  assert.equal(verdictOf('review', '看起来还行'), undefined)
  const p = pipelinesOf({ quick: ['code', 'test'], tiny: null })
  assert.deepEqual(p.quick.map(s => s.stage), ['code', 'test'])
  assert.equal(p.quick[1].bounceTo, 'code')
  assert.equal(p.tiny, undefined, 'a built-in can be switched off')
  assert.deepEqual(p.feature.map(s => s.stage), ['plan', 'code', 'test', 'commit', 'review'])
  assert.throws(() => pipelinesOf({ bad: [{ stage: 'x', needs: ['fly'] }] }), /hub.json/)
})

test('a can list routes by what the task needs; role presets still work', async (t) => {
  const { hub } = await makeHub(t)
  await crew(hub)
  const agents = Object.fromEntries((await hub.listAgents()).map(a => [a.agent_id, a]))
  assert.deepEqual(agents.agy.can, ['code', 'test'])
  assert.equal(agents.agy.can_declared, true)
  assert.deepEqual(agents.wk.can, ['plan', 'code', 'test', 'git', 'cmd'])
  // agy can code and test but never commit.
  await expectHubError(() => hub.dispatch(CTL, { title: 'x', instruction: 'commit it', agent: 'agy', needs: ['git'] }), 400, 'can-missing')
  await expectHubError(() => provision(hub, 'bad', { can: ['fly'] }), 400, 'bad-can')
})

test('feature pipeline: plan, code, a failing test bounces back, then commit and a review by someone else', async (t) => {
  const { hub, dataDir } = await makeHub(t)
  await crew(hub)
  const parent = await feature(hub)
  assert.equal(parent.status, 'running')
  assert.match(parent.pipeline, /^方案 ✱ → 干活 ○/)

  // plan: only cc and wk can plan; agy gets nothing.
  assert.equal(await take(hub, 'agy'), undefined)
  const plan = await take(hub, 'cc')
  assert.equal(plan.task_id, 'p1.plan')
  assert.equal(plan.pipeline.stage, 'plan')
  await expectHubError(() => hub.submitResult('cc', { task_id: plan.task_id, status: 'completed', summary: 'ok', files: [file('plan.md')] }), 400, 'missing-output')
  await hub.submitResult('cc', { task_id: plan.task_id, status: 'completed', summary: '方案好了', files: [file('plan.md', '改 settings.tsx'), file('acceptance.md', '- 有开关')] })

  // code: agy; its inputs are the plan files.
  const code = await take(hub, 'agy')
  assert.equal(code.task_id, 'p1.code')
  assert.deepEqual(code.inputs.map(i => i.name).sort(), ['acceptance.md', 'plan.md'])
  await hub.submitResult('agy', { task_id: code.task_id, status: 'completed', summary: '改了 settings.tsx', files: [file('changes.patch', 'diff')] })

  // test: a verdict is required; a failure bounces to a new code round.
  const t1 = await take(hub, 'wk')
  assert.equal(t1.task_id, 'p1.test')
  await expectHubError(() => hub.submitResult('wk', { task_id: t1.task_id, status: 'completed', summary: '跑完了', files: [file('test.log')] }), 400, 'missing-verdict')
  const r = await hub.submitResult('wk', { task_id: t1.task_id, status: 'completed', summary: '不通过：1 条失败', files: [file('test.log', 'FAIL')] })
  assert.equal(r.verdict, 'fail')
  let p = (await hub.listTasks({ ids: ['p1'] })).tasks?.[0] ?? (await hub.getTask('p1'))
  assert.equal(p.status, 'running')
  assert.match(p.pipeline, /第 2 轮/)

  const code2 = await take(hub, 'agy')
  assert.equal(code2.task_id, 'p1.code-r2')
  assert.match(code2.instruction, /第 2 轮/)
  const names = code2.inputs.map(i => `${i.from_task}/${i.name}`)
  assert.ok(names.includes('p1.test/test.log'), `round 2 gets the failing test log: ${names}`)
  await hub.submitResult('agy', { task_id: code2.task_id, status: 'completed', summary: '修好了', files: [file('changes.patch', 'diff2')] })
  const t2 = await take(hub, 'agy') // agy may test too
  assert.equal(t2.task_id, 'p1.test-r2')
  await hub.submitResult('agy', { task_id: t2.task_id, status: 'completed', summary: '通过 12 条', files: [file('test.log', 'ok')] })

  // commit: only wk can do git.
  assert.equal(await take(hub, 'agy'), undefined)
  assert.equal(await take(hub, 'cc'), undefined)
  const commit = await take(hub, 'wk')
  assert.equal(commit.task_id, 'p1.commit-r2')
  assert.equal(commit.pipeline.branch, 'pipeline/p1-r2')
  await hub.submitResult('wk', { task_id: commit.task_id, status: 'completed', summary: 'pipeline/p1-r2 abc123' })

  // review: agy wrote the code and cannot review anyway; cc reviews.
  const review = await take(hub, 'cc')
  assert.equal(review.task_id, 'p1.review-r2')
  await hub.submitResult('cc', { task_id: review.task_id, status: 'completed', summary: '验收完', files: [file('review.md', '通过\n- 开关在')] })

  p = await hub.getTask('p1')
  assert.equal(p.status, 'completed')
  assert.match(p.result.summary, /第 2 轮通过/)
  assert.match(p.result.summary, /pipeline\/p1-r2/)
  assert.deepEqual(p.result.outputs.map(o => o.name).sort(), ['acceptance.md', 'changes.patch', 'plan.md', 'review.md', 'test.log'])
  assert.equal(await readFile(join(dataDir, 'artifacts', 'p1', 'outputs', 'changes.patch'), 'utf8').catch(() => readFile(join(hub.artifactDir, 'p1', 'outputs', 'changes.patch'), 'utf8')), 'diff2')
  // Metrics count the stages, not the parent.
  const m = await hub.metrics()
  assert.ok(!JSON.stringify(m).includes('"p1"'))
})

test('the author never reviews: with no other reviewer the pipeline asks, and 跳过这一段 finishes it', async (t) => {
  const { hub } = await makeHub(t, { fallback: { enabled: false } })
  await provision(hub, 'cc', { can: ['plan', 'review', 'code'], workspaces: ['demo'] })
  await provision(hub, 'wk', { role: 'worker', workspaces: ['demo'] })
  await hub.heartbeat('cc', { workspaces: ['demo'] }); await hub.heartbeat('wk', { workspaces: ['demo'] })
  await hub.dispatch(CTL, { title: 't', instruction: 'i', pipeline: 'small', workspace: 'demo', task_id: 'p2' })
  const code = await take(hub, 'cc')
  assert.equal(code.task_id, 'p2.code')
  await hub.submitResult('cc', { task_id: code.task_id, status: 'completed', summary: 's', files: [file('changes.patch')] })
  const test1 = await take(hub, 'wk')
  await hub.submitResult('wk', { task_id: test1.task_id, status: 'completed', summary: '通过', files: [file('test.log')] })
  const commit = await take(hub, 'wk')
  await hub.submitResult('wk', { task_id: commit.task_id, status: 'completed', summary: 'pushed' })
  assert.equal(await take(hub, 'cc'), undefined, 'cc wrote the code and may not review it')
  let p = await hub.getTask('p2')
  assert.equal(p.status, 'waiting_input')
  assert.match(p.question.text, /不能审自己的代码/)
  await hub.answer(CTL, { task_id: 'p2', answer: '跳过这一段' })
  p = await hub.getTask('p2')
  assert.equal(p.status, 'completed')
})

test('bounce limit: once used up the pipeline asks; 到此为止 cancels it, 再来一轮 runs another round', async (t) => {
  const { hub } = await makeHub(t)
  await crew(hub)
  await hub.dispatch(CTL, { title: 't', instruction: 'i', pipeline: 'small', workspace: 'demo', task_id: 'p3', max_bounces: 0 })
  const code = await take(hub, 'agy')
  await hub.submitResult('agy', { task_id: code.task_id, status: 'completed', summary: 's', files: [file('changes.patch')] })
  const t1 = await take(hub, 'agy')
  await hub.submitResult('agy', { task_id: t1.task_id, status: 'completed', summary: '不通过', files: [file('test.log')] })
  let p = await hub.getTask('p3')
  assert.equal(p.status, 'waiting_input')
  assert.match(p.question.text, /上限 0/)
  await hub.answer(CTL, { task_id: 'p3', answer: '再来一轮 记得处理空值' })
  p = await hub.getTask('p3')
  assert.equal(p.status, 'running')
  const code2 = await take(hub, 'agy')
  assert.equal(code2.task_id, 'p3.code-r2')
  assert.match(code2.instruction, /记得处理空值/)
  await hub.submitResult('agy', { task_id: code2.task_id, status: 'failed', summary: '', error: { code: 'X', message: '编译不过' } })
  p = await hub.getTask('p3')
  assert.equal(p.status, 'waiting_input')
  await hub.answer(CTL, { task_id: 'p3', answer: '到此为止' })
  p = await hub.getTask('p3')
  assert.equal(p.status, 'cancelled')
})

test('cancelling a pipeline cancels the stage that is running', async (t) => {
  const { hub } = await makeHub(t)
  await crew(hub)
  await feature(hub)
  const plan = await take(hub, 'cc')
  await hub.cancel(CTL, 'p1', 'not needed')
  assert.equal((await hub.getTask(plan.task_id)).status, 'cancelled')
})

test('quotas by tokens: an agent over its daily tokens takes nothing until the day turns', async (t) => {
  const { hub, clock } = await makeHub(t, { quota: { agents: { agy: { tokensPerDay: 1000 } } } })
  await crew(hub)
  await hub.dispatch(CTL, { title: 't', instruction: 'i', pipeline: 'small', workspace: 'demo', task_id: 'p4' })
  const code = await take(hub, 'agy')
  await hub.submitResult('agy', { task_id: code.task_id, status: 'completed', summary: 's', files: [file('changes.patch')], usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 5000, total_cost_usd: 0.02 } })
  const agy = (await hub.listAgents()).find(a => a.agent_id === 'agy')
  assert.equal(agy.usage_today.tokens, 1200)
  assert.equal(agy.usage_today.usage_reported, true)
  assert.equal((await hub.peek('agy')).over_quota, true)
  assert.equal(await take(hub, 'agy'), undefined, 'over quota: no new task')
  const test1 = await take(hub, 'wk')
  assert.equal(test1.task_id, 'p4.test', 'the stage goes to another agent that can do it')
  const feed = await hub.feed({ after: 0 })
  assert.ok(feed.events.some(e => e.kind === 'quota' && /额度用完/.test(e.message)))
  clock.advance(DAY)
  assert.equal((await hub.peek('agy')).over_quota, undefined)
})

test('usage reported after the fact (/v1/usage) counts and attaches to the task', async (t) => {
  const { hub } = await makeHub(t)
  await crew(hub)
  await hub.dispatch(CTL, { title: 't', instruction: 'i', agent: 'agy', task_id: 'u1', needs: ['code'] })
  await take(hub, 'agy')
  await hub.submitResult('agy', { task_id: 'u1', status: 'completed', summary: 's' })
  const out = await hub.reportUsage('agy', { usage: { total_tokens: 5000, total_cost_usd: 0.1 }, task_ids: ['u1'] })
  assert.equal(out.today.tokens, 5000)
  assert.equal((await hub.getTask('u1')).usage.tokens, 5000)
  await expectHubError(() => hub.reportUsage('agy', { usage: {} }), 400, 'bad-usage')
  assert.equal(usageOf({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3 }).tokens, 6)
  assert.throws(() => quotaOf({ agents: { agy: { tokens: 1 } } }), /unknown/)
})

test('regrant: narrowing applies at once, widening waits for a controller', async (t) => {
  const { hub } = await makeHub(t)
  await provision(hub, 'agy', { role: 'coder' })
  const asked = await hub.requestChange('agy', { can: ['code', 'test'], reason: '要能跑测试' })
  assert.equal(asked.status, 'pending')
  const req = (await hub.listRequests()).find(r => r.request_id === asked.request_id)
  assert.equal(req.kind, 'change')
  assert.deepEqual(req.current.can, ['code'])
  await expectHubError(() => hub.approveRequest(CTL, asked.request_id, { can: ['code', 'test', 'git'] }), 400)
  await hub.approveRequest(CTL, asked.request_id)
  let agy = (await hub.listAgents()).find(a => a.agent_id === 'agy')
  assert.deepEqual(agy.can, ['code', 'test'])
  const narrowed = await hub.requestChange('agy', { can: ['code'] })
  assert.equal(narrowed.status, 'applied')
  agy = (await hub.listAgents()).find(a => a.agent_id === 'agy')
  assert.deepEqual(agy.can, ['code'])
})
