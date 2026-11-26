// 【作战室状态】: what is still open, re-posted after the 作战室's history is compacted.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AnchorCompactor, ASK_TTL_MS, compactStateText, isStateMessage, OpenAsks, STATE_HEAD, STATE_MAX_LINES } from '../lib/compact-state.js'
import { closesSubject } from '../lib/notices.js'

const row = (id, state, extra = {}) => ({
  id, state, subject: `任务${id}`, partition: 'web', level: 'worker', priority: 0,
  createdAt: new Date(Date.parse('2026-11-26T00:00:00Z') + Number(id.slice(1)) * 1000).toISOString(),
  updatedAt: '2026-11-26T00:00:00Z', ...extra,
})

test('open questions: the latest ask per subject, closed by a 完成/已取消 line or by age', () => {
  const asks = new OpenAsks()
  asks.note('「周报」（quick） 需要回答：用哪套模板？', 0)
  asks.note('「周报」（quick） 进度：写到第 2 节', 1)
  asks.note('「转码」（pool:media） 没人接（能接的 worker 都不在线），需要你决定：自己做、改派还是取消', 2)
  asks.note('「部署」（dev） 需要回答：今晚还是明早？', 3)
  asks.note('「部署」（dev） 完成：已部署', 4)
  assert.deepEqual(asks.list(5), ['「周报」（quick） 需要回答：用哪套模板？', '「转码」（pool:media） 没人接（能接的 worker 都不在线），需要你决定：自己做、改派还是取消'])
  asks.note('「周报」（quick） 需要回答：周报发给谁？', 6)
  assert.deepEqual(asks.list(7), ['「转码」（pool:media） 没人接（能接的 worker 都不在线），需要你决定：自己做、改派还是取消', '「周报」（quick） 需要回答：周报发给谁？'])
  assert.deepEqual(asks.list(6 + ASK_TTL_MS + 1), [], 'stale questions drop off')
  assert.equal(closesSubject('「部署」（dev） 已取消'), true)
  assert.equal(closesSubject('「部署」（dev） 失败：编译错'), false)
})

test('the state text lists unfinished board rows and open questions; nothing open, nothing posted', () => {
  assert.equal(compactStateText([row('t1', 'done'), row('t2', 'cancelled')], []), undefined)
  const text = compactStateText([
    row('t3', 'running'), row('t1', 'done'), row('t2', 'blocked', { suspendReason: '要不要\n删旧表？' }),
    row('t4', 'suspended', { suspendReason: '等 t3' }), row('t5', 'reported'),
  ], ['「周报」（quick） 需要回答：用哪套模板？'])
  assert.ok(text.startsWith(STATE_HEAD))
  assert.match(text, /- t2「任务t2」（web\/worker，等你决定）：要不要 删旧表？\n- t3「任务t3」（web\/worker，进行中）\n- t4「任务t4」（web\/worker，挂起等前置）：等 t3/)
  assert.doesNotMatch(text, /t1|t5/)
  assert.match(text, /还在等用户决定或回答的：\n- 「周报」（quick） 需要回答：用哪套模板？/)
  assert.equal(compactStateText([], ['「周报」（quick） 需要回答：用哪套模板？']).includes('本机看板'), false)
})

test('long lists keep the newest rows and count the rest', () => {
  const rows = Array.from({ length: STATE_MAX_LINES + 3 }, (_, i) => row(`t${String(i + 1)}`, 'queued'))
  const text = compactStateText(rows, [])
  assert.match(text, /（另有 3 条较早的未列出）/)
  assert.doesNotMatch(text, /t3「/)
  assert.match(text, new RegExp(`t${String(STATE_MAX_LINES + 3)}「`))
})

test('isStateMessage recognises the router\'s own state message only', () => {
  const msg = text => ({ id: 'm', role: 'user', content: [{ type: 'text', text }] })
  assert.equal(isStateMessage(msg(`${STATE_HEAD}\nx`)), true)
  assert.equal(isStateMessage(msg('【进度提醒】\n- x')), false)
  assert.equal(isStateMessage({ role: 'assistant', content: [{ type: 'text', text: STATE_HEAD }] }), false)
})

const settle = ms => new Promise(resolve => setTimeout(resolve, ms))
const quietLog = () => { const lines = []; return { lines, info: m => lines.push(m), warn: m => lines.push(`WARN ${m}`) } }

test('anchor compaction: past the threshold, waits for idle, then compacts once', async () => {
  const agent = { status: 'running' }
  const calls = []
  const log = quietLog()
  const compactor = new AnchorCompactor({
    threshold: 1000, retryMs: 5, log,
    agent: () => agent,
    engine: () => ({ compactNow: async (a, signal) => { calls.push([a, signal.aborted]); return { shadowedTokenCount: 900 } } }),
  })
  compactor.sample(999)
  compactor.turnEnded()
  await settle(20)
  assert.equal(calls.length, 0, 'under the threshold nothing happens')
  compactor.sample(1200)
  compactor.turnEnded()
  await settle(20)
  assert.equal(calls.length, 0, 'not while the 作战室 is working')
  agent.status = 'idle'
  await settle(20)
  assert.deepEqual(calls, [[agent, false]])
  compactor.turnEnded()
  await settle(20)
  assert.equal(calls.length, 1, 'the size is unknown again after compacting')
  assert.match(log.lines.at(-1), /1200 tokens, compacted/)
  compactor.dispose()
})

test('anchor compaction: busy retries, other failures pause, 0 turns it off', async () => {
  let fail = 'busy'
  let calls = 0
  const log = quietLog()
  const compactor = new AnchorCompactor({
    threshold: 10, retryMs: 5, log,
    agent: () => ({ status: 'idle' }),
    engine: () => ({ compactNow: async () => { calls++; if (fail === 'busy') { fail = undefined; throw Object.assign(new Error('busy'), { code: 'busy' }) } if (fail === 'summary') throw new Error('model down'); return null } }),
  })
  compactor.sample(50)
  compactor.turnEnded()
  await settle(30)
  assert.equal(calls, 2, 'a busy refusal is retried')

  let failing = 0
  const paused = new AnchorCompactor({
    threshold: 10, retryMs: 5, log,
    agent: () => ({ status: 'idle' }),
    engine: () => ({ compactNow: async () => { failing++; throw new Error('model down') } }),
  })
  paused.sample(50)
  paused.turnEnded()
  await settle(20)
  paused.sample(60)
  paused.turnEnded()
  await settle(20)
  assert.equal(failing, 1, 'a failed summary is not retried on the next turn')
  assert.match(log.lines.at(-1), /WARN .*retrying in 10 minutes/)

  let never = 0
  const off = new AnchorCompactor({ threshold: 0, retryMs: 5, log, agent: () => ({ status: 'idle' }), engine: () => ({ compactNow: async () => { never++; return null } }) })
  off.sample(10 ** 9)
  off.turnEnded()
  await settle(20)
  assert.equal(never, 0)
  for (const c of [compactor, paused, off]) c.dispose()
})
