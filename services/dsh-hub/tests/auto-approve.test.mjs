/**
 * hub.json "autoApprove": /v1/enroll is granted on the spot, with exactly what
 * the request asked for (no controller token, no human, no widening).
 *
 * The allow list is the security boundary and lives in the HTTP layer, so the
 * handler tests below drive it with a fake socket address: an address outside
 * `allow` gets 403 before any route (autoApprove never runs), an allow-listed
 * one goes straight from request to token without a controller.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigError, resolveConfig } from '../lib/config.js'
import { createHandler } from '../lib/http.js'
import { AUTO_APPROVED_BY } from '../lib/hub.js'
import { CTL, callHttp, jsonHeaders, makeHub } from './helpers.mjs'

const WS = 'deepseek-harness'
const asked = {
  agent_id: 'auto-worker', platform: 'aws-quick', node: 'workstation',
  workspaces: [WS], capabilities: ['researcher:1', 'quick:2'], max_concurrency: 2,
  role: 'tester', pull_every_seconds: 900, description: 'auto-approve test worker',
}

// --- hub core ------------------------------------------------------------------------

test('autoApprove off (default): the request stays pending and no agent is created', async (t) => {
  const { hub } = await makeHub(t)
  const out = await hub.requestEnrollment(asked)
  assert.deepEqual([out.status, out.auto_approved], ['pending', undefined])
  const [req] = await hub.listRequests()
  assert.deepEqual([req.status, req.auto_approved, req.decided_by], ['pending', false, undefined])
  assert.deepEqual(await hub.listAgents(), [], 'nothing exists before a controller approves')
  assert.equal((await hub.enrollmentStatus({ request_id: out.request_id, poll_secret: out.poll_secret })).status, 'pending')
})

test('autoApprove on: request -> approved at once, grant equals the request (no controller, no widening)', async (t) => {
  const { hub, logger } = await makeHub(t, { autoApprove: true })
  const out = await hub.requestEnrollment({ ...asked, from: '203.0.113.9' })
  assert.deepEqual([out.status, out.auto_approved], ['approved', true])

  const [req] = await hub.listRequests({ status: 'approved' })
  assert.equal(req.decided_by, AUTO_APPROVED_BY)
  assert.equal(req.auto_approved, true)
  assert.equal(req.from, '203.0.113.9')
  // Exactly the asked grant: same platform, node, role, capabilities, workspaces, concurrency.
  assert.deepEqual(
    [req.platform, req.node, req.role, req.capabilities, req.capability_limits, req.workspaces, req.max_concurrency, req.pull_every_seconds],
    [asked.platform, asked.node, asked.role, ['researcher', 'quick'], { researcher: 1, quick: 2 }, asked.workspaces, asked.max_concurrency, asked.pull_every_seconds],
  )
  assert.deepEqual(await hub.listRequests(), [], 'it never sits in the pending queue')

  const [agent] = await hub.listAgents()
  assert.deepEqual([agent.agent_id, agent.status, agent.role, agent.capabilities, agent.capability_limits, agent.workspaces, agent.max_concurrency],
    [asked.agent_id, 'pending', 'tester', ['researcher', 'quick'], { researcher: 1, quick: 2 }, asked.workspaces, asked.max_concurrency])
  assert.equal(agent.token_hash, undefined, 'no token is stored, only its hash later')

  // The requester collects the token exactly as after a human approval, then heartbeats to online.
  const { token } = await hub.enrollmentStatus({ request_id: out.request_id, poll_secret: out.poll_secret })
  assert.match(token, new RegExp('^dsh' + 'a_auto-worker_'))
  const hb = await hub.heartbeat('auto-worker', { status: 'idle', workspaces: [WS] })
  assert.equal(hb.status, 'online')
  const [online] = await hub.listAgents()
  assert.deepEqual([online.online, online.status, online.role], [true, 'online', 'tester'])

  // Traceability: UTC time, source address, agent id and the granted scope in the log.
  const line = logger.lines.find(l => l.includes('AUTO-APPROVE'))
  assert.ok(line, 'the auto approval is logged')
  assert.match(line, /AUTO-APPROVE req_\S+ agent=auto-worker at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/)
  assert.match(line, /from=203\.0\.113\.9/)
  assert.match(line, /role=tester capabilities=\[researcher:1,quick:2\] workspaces=\[deepseek-harness\] max_concurrency=2/)
  assert.match(line, /decided_by=auto-approve/)
})

test('autoApprove keeps the "agent already registered" refusal', async (t) => {
  const { hub } = await makeHub(t, { autoApprove: true })
  const first = await hub.requestEnrollment({ agent_id: 'auto-worker' })
  assert.equal(first.status, 'approved')
  await hub.enrollmentStatus({ request_id: first.request_id, poll_secret: first.poll_secret })
  await assert.rejects(() => hub.requestEnrollment({ agent_id: 'auto-worker' }), e => e.status === 409 && e.code === 'agent-exists')
})

test('autoApprove stores no controller decision path: revoking still needs a controller', async (t) => {
  const { hub } = await makeHub(t, { autoApprove: true })
  const out = await hub.requestEnrollment({ agent_id: 'auto-worker' })
  await hub.enrollmentStatus({ request_id: out.request_id, poll_secret: out.poll_secret })
  await hub.revokeAgent(CTL, 'auto-worker')
  const [agent] = await hub.listAgents()
  assert.equal(agent.status, 'revoked')
})

// --- allow list runs first -----------------------------------------------------------

test('allow list runs before autoApprove: a non-allowed address gets 403 and creates nothing', async (t) => {
  const base = await makeHub(t, { autoApprove: true })
  const handler = createHandler({ hub: base.hub, logger: base.logger, allow: ['203.0.113.0/24'], trustProxy: false })
  const enroll = (remoteAddress) => callHttp(handler, {
    method: 'POST', url: '/v1/enroll?id=auto-worker', remoteAddress,
    headers: jsonHeaders(), body: { platform: 'aws-quick', capabilities: ['quick:2'], workspaces: [WS], role: 'tester' },
  })

  const denied = await enroll('198.51.100.4')
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json().error.code, 'ip-not-allowed')
  assert.deepEqual(await base.hub.listRequests({ status: 'all' }), [], 'refused before the route: no request, no agent')
  assert.deepEqual(await base.hub.listAgents(), [])

  const ok = await enroll('::ffff:203.0.113.50')
  assert.equal(ok.statusCode, 200)
  const out = ok.json()
  assert.deepEqual([out.status, out.auto_approved], ['approved', true])
  const status = await callHttp(handler, {
    method: 'POST', url: '/v1/enroll/status?id=auto-worker', remoteAddress: '203.0.113.50',
    headers: jsonHeaders(), body: { request_id: out.request_id, poll_secret: out.poll_secret },
  })
  assert.match(status.json().token, new RegExp('^dsh' + 'a_auto-worker_'))
  const [req] = await base.hub.listRequests({ status: 'approved' })
  assert.equal(req.from, '203.0.113.50')
})

// --- configuration -----------------------------------------------------------------

test('hub.json autoApprove: default off, boolean only, and refused without an allow list', () => {
  assert.equal(resolveConfig({}).config.autoApprove, false)
  assert.equal(resolveConfig({ autoApprove: false, allow: ['203.0.113.0/24'] }).config.autoApprove, false)
  const on = resolveConfig({ autoApprove: true, allow: ['203.0.113.0/24'] })
  assert.equal(on.config.autoApprove, true)
  assert.ok(on.warnings.some(w => w.includes('autoApprove is ON')), 'starting with it on warns')
  assert.throws(() => resolveConfig({ autoApprove: 'yes' }), ConfigError)
  assert.throws(() => resolveConfig({ autoApprove: 1 }), ConfigError)
  // Fail closed: no allow list means any address could enroll, so the hub does not start.
  assert.throws(() => resolveConfig({ autoApprove: true, allow: [] }), e => e instanceof ConfigError && /non-empty "allow"/.test(e.message))
  assert.throws(() => resolveConfig({ autoApprove: true }), ConfigError)
})
