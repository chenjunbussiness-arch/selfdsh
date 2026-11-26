/**
 * The mailbox: every event goes to the DSH that published the task (its controller
 * and, when given, its profile: `reply_to`), not to every DSH on the hub; a result is
 * taken only from the run (attempt) it belongs to; a task nobody took goes back to its
 * publisher once (`fallback_due`), and only the publisher may take it over.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHandler } from '../lib/http.js'
import { isForInbox, publishedBy } from '../lib/hub.js'
import { CTL, CTL2, callHttp, dispatchTask, expectHubError, makeHub, provision } from './helpers.mjs'

const WS = 'deepseek-harness'
const kinds = out => out.events.map(e => `${e.task_id}:${e.kind}`)

async function online(hub, id, extra = {}) {
  await provision(hub, id, { node: 'mydesk', workspaces: [WS], ...extra })
  await hub.heartbeat(id, { status: 'idle', workspaces: [WS] })
}

test('feed inbox: a task published from the cloud profile reaches that DSH only', async (t) => {
  const { hub } = await makeHub(t)
  await online(hub, 'worker', { max_concurrency: 3 })
  await dispatchTask(hub, { task_id: 'c1', reply_to: 'cloud' })
  await dispatchTask(hub, { task_id: 'l1', reply_to: 'web' })
  await dispatchTask(hub, { task_id: 'o1' }, CTL2)
  await hub.poll('worker', { max: 3 })
  await hub.submitResult('worker', { task_id: 'c1', status: 'completed', summary: 'done' })

  const cloud = await hub.feed({ inbox: { controller: CTL, profile: 'cloud' } })
  assert.deepEqual(kinds(cloud), ['c1:created', 'c1:accepted', 'c1:completed'])
  const web = await hub.feed({ inbox: { controller: CTL, profile: 'web' } })
  assert.deepEqual(kinds(web), ['l1:created', 'l1:accepted'])
  const other = await hub.feed({ inbox: { controller: CTL2 } })
  assert.deepEqual(kinds(other), ['o1:created', 'o1:accepted'])
  // The cursor moves past the other inboxes' mail.
  assert.equal(web.next, web.latest)
  const all = await hub.feed({})
  assert.equal(all.events.length, 7, 'no inbox: the whole stream (observer)')
  assert.equal(cloud.events.at(-1).reply_to, 'cloud')
  assert.equal(cloud.events.at(-1).attempt, 1)
})

test('feed inbox: a long poll waits past other DSHs\' mail', async (t) => {
  const { hub } = await makeHub(t)
  await online(hub, 'worker')
  const start = (await hub.feed({})).latest
  const waiting = hub.feed({ after: start, wait: 1, inbox: { controller: CTL, profile: 'web' } })
  await dispatchTask(hub, { task_id: 'c1', reply_to: 'cloud' })
  const out = await waiting
  assert.deepEqual(out.events, [])
  assert.equal(out.next, out.latest, 'skipped past the cloud task')
  const mine = hub.feed({ after: out.next, wait: 2, inbox: { controller: CTL, profile: 'web' } })
  await dispatchTask(hub, { task_id: 'w1', reply_to: 'web' })
  assert.deepEqual(kinds(await mine), ['w1:created'])
})

test('isForInbox / publishedBy: old tasks without reply_to reach every profile of their controller; fallback holders hear of cancels', () => {
  assert.equal(isForInbox({ created_by: CTL, kind: 'completed' }, { controller: CTL, profile: 'web' }), true)
  assert.equal(isForInbox({ created_by: CTL, reply_to: 'cloud', kind: 'completed' }, { controller: CTL, profile: 'web' }), false)
  assert.equal(isForInbox({ created_by: CTL, reply_to: 'cloud', held_by: CTL2, kind: 'cancelled' }, { controller: CTL2 }), true)
  assert.equal(isForInbox({ created_by: CTL, reply_to: 'cloud', held_by: CTL2, kind: 'progress' }, { controller: CTL2 }), false)
  assert.equal(publishedBy({ created_by: 'agent:planner' }, CTL2, 'web'), true)
  assert.equal(publishedBy({ created_by: CTL, reply_to: 'cloud' }, CTL, 'web'), false)
  assert.equal(publishedBy({ created_by: CTL, reply_to: 'cloud' }, CTL, undefined), true)
})

test('reply_to is validated and shown on the task', async (t) => {
  const { hub } = await makeHub(t)
  await online(hub, 'worker')
  await expectHubError(() => dispatchTask(hub, { reply_to: '../x' }), 400, 'bad-reply-to')
  const task = await dispatchTask(hub, { task_id: 'r1', reply_to: 'cloud' })
  assert.equal(task.reply_to, 'cloud')
  const local = await hub.dispatch(CTL, { title: 'here', instruction: 'x', run_here: true, dsh_profile: 'web', task_id: 'h1' })
  assert.equal(local.reply_to, 'web', 'a task a DSH runs itself answers to its own profile')
})

test('a result from an earlier run (attempt) of the same task is refused', async (t) => {
  const { hub, clock } = await makeHub(t)
  await online(hub, 'worker')
  await dispatchTask(hub, { task_id: 'a1', lease_seconds: 60 })
  const [first] = (await hub.poll('worker')).tasks
  assert.equal(first.attempt, 1)
  clock.advance(61_000)
  await hub.heartbeat('worker', { status: 'idle', workspaces: [WS] })
  await hub.sweep() // lease expired: requeued
  const [second] = (await hub.poll('worker')).tasks
  assert.equal(second.attempt, 2)
  await expectHubError(() => hub.progress('worker', { task_id: 'a1', attempt: 1, message: 'old run' }), 409, 'stale-attempt')
  await expectHubError(() => hub.submitResult('worker', { task_id: 'a1', attempt: 1, status: 'completed', summary: 'old' }), 409, 'stale-attempt')
  const ok = await hub.submitResult('worker', { task_id: 'a1', attempt: 2, status: 'completed', summary: 'new' })
  assert.equal(ok.task_status, 'completed')
  assert.equal((await hub.getTask('a1')).result.summary, 'new')
})

test('nobody can take it: the publisher is told once (fallback_due) and only it may take it over', async (t) => {
  const { hub } = await makeHub(t)
  await dispatchTask(hub, { task_id: 'f1', agent: 'pool:report', reply_to: 'cloud' })
  await hub.sweep()
  await hub.sweep()
  const cloud = await hub.feed({ inbox: { controller: CTL, profile: 'cloud' } })
  assert.deepEqual(kinds(cloud), ['f1:created', 'f1:fallback_due'])
  assert.equal(cloud.events[1].message, 'no worker that can take it is online')
  assert.equal((await hub.getTask('f1')).history.length, 1, 'the notice adds nothing to the task\'s own history')
  assert.deepEqual(await hub.listFallback(CTL2), [])
  assert.deepEqual(await hub.listFallback(CTL, { profile: 'web' }), [])
  await expectHubError(() => hub.takeFallback(CTL2, { task_id: 'f1' }), 403, 'not-publisher')
  await expectHubError(() => hub.takeFallback(CTL, { task_id: 'f1', profile: 'web' }), 403, 'not-publisher')
  assert.equal((await hub.takeFallback(CTL2, {})).task, null)
  const taken = await hub.takeFallback(CTL, { task_id: 'f1', profile: 'cloud' })
  assert.equal(taken.task.task_id, 'f1')
})

test('HTTP: /v1/ctl/events?inbox=mine&profile= and /v1/ctl/fallback?profile=', async (t) => {
  const { hub, ctlToken } = await makeHub(t)
  const handler = createHandler({ hub })
  await online(hub, 'worker')
  await dispatchTask(hub, { task_id: 'c1', reply_to: 'cloud' })
  await dispatchTask(hub, { task_id: 'w1', reply_to: 'web' })
  const get = async url => callHttp(handler, { method: 'GET', url, headers: { 'X-DSH-Token': ctlToken } })
  const mine = await get(`/v1/ctl/events?id=${CTL}&inbox=mine&profile=cloud`)
  assert.equal(mine.statusCode, 200)
  assert.deepEqual(mine.json().events.map(e => e.task_id), ['c1'])
  assert.equal((await get(`/v1/ctl/events?id=${CTL}`)).json().events.length, 2)
  assert.equal((await get(`/v1/ctl/events?id=${CTL}&inbox=some`)).statusCode, 400)
  assert.equal((await get(`/v1/ctl/events?id=${CTL}&inbox=mine&profile=../x`)).statusCode, 400)
  assert.equal((await get(`/v1/ctl/fallback?id=${CTL}&profile=web`)).statusCode, 200)
})
