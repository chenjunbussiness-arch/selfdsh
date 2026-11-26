import assert from 'node:assert/strict'
import { roleDuties } from '../roles.js'
import test from 'node:test'
import { HubError } from '../hub-client.js'
import { TOOL_NAMES, createTools } from '../tools.js'
import { CONTROLLER, HUB_URL, TOKEN, assertNoToken, b64, makeClient } from './helpers.mjs'

const NAMES = [
  'agent_provision', 'agent_revoke', 'agent_list', 'agent_requests', 'agent_approve', 'agent_reject',
  'task_dispatch', 'task_list', 'task_session', 'task_ack', 'task_answer', 'task_timeline', 'task_metrics', 'task_get', 'task_cancel', 'task_retry',
  'fallback_list', 'fallback_take', 'fallback_submit',
]
const READ_ONLY = new Set(['agent_list', 'agent_requests', 'task_list', 'task_get', 'task_session', 'task_timeline', 'task_metrics', 'fallback_list'])

function setup(handler = () => ({ body: {} }), options = {}) {
  const base = makeClient(handler, options)
  const tools = createTools({ client: base.client })
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const call = async (name, args = {}) => {
    const tool = byName.get(name)
    assert.ok(tool, `tool ${name} missing`)
    return tool.execute(args, { signal: new AbortController().signal })
  }
  return { ...base, tools, byName, call }
}

/** Assert a tool call rejects with this HubError status / code and a `[code]` message. */
async function rejectsWith(run, status, code) {
  let caught
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof HubError, String(error))
    assert.equal(error.status, status)
    assert.equal(error.code, code)
    assert.ok(error.message.startsWith(`[${code}] `), error.message)
    caught = error
    return true
  })
  return caught
}

test('createTools returns the 19 DSH control tools with unchanged names', () => {
  const { tools } = setup()
  assert.deepEqual(TOOL_NAMES, NAMES)
  assert.equal(tools.length, 19)
  assert.deepEqual(tools.map(tool => tool.name), NAMES)
})

test('every tool has a closed object schema, a description and a JSON renderer', () => {
  const { tools } = setup()
  for (const tool of tools) {
    const p = tool.parameters
    assert.equal(p.type, 'object', tool.name)
    assert.equal(p.additionalProperties, false, `${tool.name} must not accept unknown arguments`)
    assert.equal(typeof p.properties, 'object', tool.name)
    for (const key of p.required ?? []) assert.ok(key in p.properties, `${tool.name}.required lists unknown ${key}`)
    assert.ok(typeof tool.description === 'string' && tool.description.length > 10, tool.name)
    assert.equal(typeof tool.execute, 'function')
    assert.deepEqual(tool.output.schema, { type: 'object' })
    const value = { a: 1, nested: { b: [2] } }
    assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: JSON.stringify(value, undefined, 2) }])
  }
})

test('parameters: v1 arguments kept, v2 workspace / node / ref / workspaces added', () => {
  const { byName } = setup()
  const required = name => byName.get(name).parameters.required ?? []
  const props = name => byName.get(name).parameters.properties
  assert.deepEqual(required('agent_provision'), ['agent_id'])
  assert.deepEqual(required('agent_revoke'), ['agent_id'])
  assert.deepEqual(required('agent_approve'), ['request_id'])
  assert.deepEqual(required('agent_reject'), ['request_id'])
  assert.deepEqual(required('task_dispatch'), ['agent', 'title', 'instruction'])
  assert.deepEqual(required('task_get'), ['task_id'])
  assert.deepEqual(required('task_cancel'), ['task_id'])
  assert.deepEqual(required('task_retry'), ['task_id'])
  for (const name of ['agent_list', 'agent_requests', 'task_list']) assert.deepEqual(required(name), [], name)
  for (const key of ['agent', 'title', 'instruction', 'type', 'task_id', 'inputs', 'output', 'priority', 'deadline', 'lease_seconds', 'depends_on', 'parent_task_id', 'context', 'workspace', 'node', 'ref']) {
    assert.ok(key in props('task_dispatch'), `task_dispatch.${key}`)
  }
  for (const key of ['request_id', 'capabilities', 'max_concurrency', 'workspaces']) assert.ok(key in props('agent_approve'), `agent_approve.${key}`)
  assert.deepEqual(props('agent_approve').workspaces, { type: 'array', items: { type: 'string' }, description: props('agent_approve').workspaces.description })
  for (const key of ['status', 'agent', 'workspace', 'limit']) assert.ok(key in props('task_list'), `task_list.${key}`)
  for (const key of ['agent_id', 'platform', 'mode', 'capabilities', 'max_concurrency', 'description', 'node', 'workspaces']) assert.ok(key in props('agent_provision'), `agent_provision.${key}`)
  assert.deepEqual(props('task_dispatch').type.enum, ['research', 'document', 'data', 'code', 'review', 'custom'])
  assert.deepEqual(props('task_dispatch').priority.enum, ['low', 'normal', 'high'])
  assert.deepEqual(props('agent_provision').mode.enum, ['poll', 'push'])
  assert.deepEqual(props('agent_requests').status.enum, ['pending', 'approved', 'rejected', 'expired', 'all'])
})

test('read-only tools are concurrency safe, mutating ones are not', () => {
  const { tools } = setup()
  for (const tool of tools) assert.equal(tool.isConcurrencySafe(), READ_ONLY.has(tool.name), tool.name)
})

test('each tool is one /v1/ctl call with the right method, query and body', async () => {
  const { call, calls } = setup((c) => {
    if (c.path === '/v1/ctl/output') return { raw: '# answer\n42' }
    if (c.path === '/v1/ctl/tasks') return { body: { tasks: [{ task_id: 't1' }] } }
    if (c.path === '/v1/ctl/agents') return { body: { agents: [{ agent_id: 'quick-mydesk' }] } }
    if (c.path === '/v1/ctl/requests') return { body: { requests: [{ request_id: 'req_1' }] } }
    if (c.path === '/v1/ctl/task') return { body: { task_id: 't1', status: 'completed', instruction: 'Find it.' } }
    if (c.path === '/v1/ctl/provision') return { body: { agent: { agent_id: 'claude-cloud' }, token: 'dsha_claude-cloud_W0rkerTok' } }
    return { body: { echo: c.path } }
  })
  const last = () => calls.at(-1)
  const q = () => Object.fromEntries(last().query.entries())

  const dispatched = await call('task_dispatch', { agent: 'pool:code', title: 'Fix', instruction: 'Fix the bug.', type: 'code', workspace: 'deepseek-harness', node: 'mydesk', ref: 'feature/x', inputs: [{ name: 'a.txt', text: 'a' }] })
  assert.deepEqual(dispatched, { echo: '/v1/ctl/dispatch' })
  assert.equal(last().method, 'POST')
  assert.deepEqual(last().json, { agent: 'pool:code', title: 'Fix', instruction: 'Fix the bug.', type: 'code', workspace: 'deepseek-harness', node: 'mydesk', ref: 'feature/x', inputs: [{ name: 'a.txt', text: 'a' }] })

  assert.deepEqual(await call('task_list', { status: 'running', workspace: 'deepseek-harness', limit: 10 }), { tasks: [{ task_id: 't1' }] })
  assert.deepEqual(q(), { id: CONTROLLER, status: 'running', workspace: 'deepseek-harness', limit: '10' })
  await call('task_list')
  assert.deepEqual(q(), { id: CONTROLLER })

  const got = await call('task_get', { task_id: 't1' })
  assert.equal(got.instruction, 'Find it.')
  assert.equal(got.output_text, undefined)
  const withOutput = await call('task_get', { task_id: 't1', output_name: 'answer.md' })
  assert.equal(withOutput.output_text, '# answer\n42')
  assert.equal(last().path, '/v1/ctl/output')
  assert.deepEqual(q(), { id: CONTROLLER, task_id: 't1', name: 'answer.md' })

  await call('task_cancel', { task_id: 't1', reason: 'stop' })
  assert.deepEqual([last().path, last().json], ['/v1/ctl/cancel', { task_id: 't1', reason: 'stop' }])
  await call('task_retry', { task_id: 't1', agent: 'quick-mydesk' })
  assert.deepEqual([last().path, last().json], ['/v1/ctl/retry', { task_id: 't1', agent: 'quick-mydesk' }])

  assert.deepEqual(await call('agent_list'), { agents: [{ agent_id: 'quick-mydesk', role: 'worker', duties: roleDuties('worker') }] }, 'role and duties are always reported (worker when the hub sends none)')
  assert.deepEqual(await call('agent_requests'), { requests: [{ request_id: 'req_1' }] })
  assert.deepEqual(q(), { id: CONTROLLER, status: 'pending' }, 'agent_requests defaults to pending')
  await call('agent_requests', { status: 'all' })
  assert.deepEqual(q(), { id: CONTROLLER, status: 'all' })
  await call('agent_approve', { request_id: 'req_1', workspaces: ['deepseek-harness'], capabilities: ['code'], max_concurrency: 1 })
  assert.deepEqual([last().path, last().json], ['/v1/ctl/approve', { request_id: 'req_1', capabilities: ['code'], workspaces: ['deepseek-harness'], max_concurrency: 1 }])
  await call('agent_reject', { request_id: 'req_2', reason: 'unknown' })
  assert.deepEqual([last().path, last().json], ['/v1/ctl/reject', { request_id: 'req_2', reason: 'unknown' }])
  await call('agent_revoke', { agent_id: 'quick-mydesk' })
  assert.deepEqual([last().path, last().json], ['/v1/ctl/revoke', { agent_id: 'quick-mydesk' }])

  const provisioned = await call('agent_provision', { agent_id: 'claude-cloud', platform: 'claude-code', node: 'cloud', workspaces: ['deepseek-harness'] })
  assert.deepEqual(last().json, { agent_id: 'claude-cloud', platform: 'claude-code', node: 'cloud', workspaces: ['deepseek-harness'] })
  assert.equal(provisioned.token, 'dsha_claude-cloud_W0rkerTok', 'the worker token is shown once, by design')
  assert.equal(provisioned.endpoint, `${HUB_URL}/v1`, 'workers connect straight to the hub')
  assert.match(provisioned.note, /not shown again/)
  await call('task_answer', { task_id: 't1', answer: 'SQLite' })
  assert.deepEqual([last().method, last().path, last().json], ['POST', '/v1/ctl/answer', { task_id: 't1', answer: 'SQLite' }])
  await call('task_timeline', { task_id: 't1' })
  assert.deepEqual([last().method, last().path, q()], ['GET', '/v1/ctl/timeline', { id: CONTROLLER, task_id: 't1' }])
  await call('task_metrics', { hours: 24 })
  assert.deepEqual([last().method, last().path, q()], ['GET', '/v1/ctl/metrics', { id: CONTROLLER, hours: '24' }])
  for (const c of calls) assert.equal(c.headers['X-DSH-Token'], TOKEN)
})

test('task_dispatch type "code" needs a workspace (checked before calling the hub)', async () => {
  const { call, calls } = setup()
  await rejectsWith(() => call('task_dispatch', { agent: 'pool:code', title: 't', instruction: 'i', type: 'code' }), 400, 'bad-task')
  await rejectsWith(() => call('task_dispatch', { agent: 'pool:code', title: 't', instruction: 'i', type: 'code', workspace: '  ' }), 400, 'bad-task')
  assert.equal(calls.length, 0)
  await call('task_dispatch', { agent: 'pool:research', title: 't', instruction: 'i', type: 'research' })
  // 1 = the role lookup (GET /v1/ctl/agents), 2 = the dispatch itself.
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /v1/ctl/agents', 'POST /v1/ctl/dispatch'], 'other types may omit workspace')
})

test('errors are clear: [code] message, status kept, nothing sent without a token', async () => {
  const none = setup(() => ({ body: {} }), { env: {} })
  for (const name of NAMES) {
    const args = { agent_id: 'quick-mydesk', request_id: 'req_1', task_id: 't1', agent: 'quick-mydesk', title: 't', instruction: 'i' }
    const allowed = Object.fromEntries(Object.entries(args).filter(([k]) => k in none.byName.get(name).parameters.properties))
    const error = await rejectsWith(() => none.call(name, allowed), 503, 'hub-token-missing')
    assert.match(error.message, /DSH_HUB_TOKEN is not set/)
  }
  assert.equal(none.calls.length, 0)

  const down = setup(() => ({ networkError: 'ECONNREFUSED' }))
  await rejectsWith(() => down.call('agent_list'), 503, 'hub-unreachable')
  const refused = setup({ 'POST /v1/ctl/cancel': { status: 403, body: { error: { code: 'not-creator', message: 'only the creating controller may cancel' } } } })
  const e = await rejectsWith(() => refused.call('task_cancel', { task_id: 't1' }), 403, 'not-creator')
  assert.equal(e.message, '[not-creator] only the creating controller may cancel')
})

test('the controller token never appears in tool outputs or errors', async () => {
  const { call } = setup({
    'GET /v1/ctl/task': { body: { task_id: 't1', instruction: `use ${TOKEN}`, context: { leaked: TOKEN } } },
    'GET /v1/ctl/output': { raw: `secret=${TOKEN}` },
    'GET /v1/ctl/agents': { status: 401, body: { error: { code: 'unauthorized', message: `bad token ${TOKEN}` } } },
    'POST /v1/ctl/dispatch': { body: { task_id: 't2', inputs: [b64('x')] } },
  })
  const got = await call('task_get', { task_id: 't1', output_name: 'out.txt' })
  assertNoToken(got)
  assert.equal(got.instruction, 'use ***')
  assert.equal(got.output_text, 'secret=***')
  const e = await rejectsWith(() => call('agent_list'), 401, 'unauthorized')
  assertNoToken(e.message, e.stack)
})

test('task_dispatch effort goes to the hub (checked there) and, for older hubs, into context.effort', async () => {
  const { call, calls, byName } = setup()
  // Every dispatch is one role lookup (GET /v1/ctl/agents) + the POST itself.
  const posts = () => calls.filter(c => c.method === 'POST')
  const props = name => byName.get(name).parameters.properties
  assert.deepEqual(props('task_dispatch').effort.properties.mode.enum, ['fast', 'balanced', 'smart'])
  assert.deepEqual(props('task_dispatch').effort.properties.thinking.enum, ['off', 'low', 'medium', 'high'])
  assert.equal(props('task_dispatch').effort.properties.agent.type, 'string')
  await call('task_dispatch', { agent: 'quick-mydesk', title: 't', instruction: 'i', effort: { mode: 'smart', thinking: 'high', agent: 'quick' } })
  assert.deepEqual(posts()[0].json, {
    agent: 'quick-mydesk', title: 't', instruction: 'i',
    effort: { mode: 'smart', thinking: 'high', agent: 'quick' },
    context: { effort: { mode: 'smart', thinking: 'high', agent: 'quick' } },
  })
  await call('task_dispatch', { agent: 'quick-mydesk', title: 't', instruction: 'i', context: { project: 'x' }, effort: { mode: 'fast' } })
  assert.deepEqual(posts()[1].json.context, { project: 'x', effort: { mode: 'fast' } })
  assert.deepEqual(posts()[1].json.effort, { mode: 'fast' })
  await call('task_dispatch', { agent: 'quick-mydesk', title: 't', instruction: 'i' })
  assert.equal('context' in posts()[2].json, false, 'no context added without effort')
  await rejectsWith(() => call('task_dispatch', { agent: 'quick-mydesk', title: 't', instruction: 'i', effort: { mode: 'fast', thinking: 'high' } }), 400, 'bad-task')
  assert.equal(posts().length, 3)
})

// --- presence (hub v2: status / warnings / require_online) ------------------------------

test('task_dispatch forwards require_online and hands the hub warnings back unchanged', async () => {
  const { call, calls } = setup((c) => {
    if (c.json?.require_online === true) return { status: 409, body: { error: { code: 'agent-offline', message: 'quick-mydesk is offline (last seen 2026-11-22T10:00:00.000Z)' } } }
    return { body: { task_id: 't1', status: 'pending', agent: 'quick-mydesk', warnings: ['agent-offline'] } }
  })
  const posts = () => calls.filter(c => c.method === 'POST')
  const queued = await call('task_dispatch', { agent: 'quick-mydesk', title: 't', instruction: 'i' })
  assert.deepEqual(queued.warnings, ['agent-offline'])
  assert.equal(queued.status, 'pending')
  assert.equal('require_online' in posts()[0].json, false, 'not sent when not given')
  await rejectsWith(() => call('task_dispatch', { agent: 'quick-mydesk', title: 't', instruction: 'i', require_online: true }), 409, 'agent-offline')
  assert.equal(posts()[1].json.require_online, true)
  const { call: call2 } = setup(() => ({ body: { task_id: 't2', status: 'pending' } }))
  assert.equal((await call2('task_dispatch', { agent: 'pool:code', title: 't', instruction: 'i' })).warnings, undefined, 'no warnings key without warnings')
})

test('agent_list passes status / last_seen / version through (and adds the role, worker by default)', async () => {
  const agent = { agent_id: 'quick-mydesk', status: 'left', online: false, last_seen: '2026-11-22T10:00:00.000Z', left_at: '2026-11-22T10:01:00.000Z', version: 'agent_client/2.1.0' }
  const { call } = setup(() => ({ body: { agents: [agent, { agent_id: 'quick-2', role: 'coder', duties: { role: 'coder', can: ['x'], cannot: ['y'] } }] } }))
  const out = await call('agent_list')
  assert.deepEqual(out.agents[0], { ...agent, role: 'worker', duties: roleDuties('worker') })
  assert.deepEqual(out.agents[1].duties, { role: 'coder', can: ['x'], cannot: ['y'] }, 'the hub\'s own duties win')
})

test('task_dispatch: a coder is refused a task that runs tests or git, before the hub sees it', async () => {
  const { call, calls } = setup((c) => (c.path === '/v1/ctl/agents' ? { body: { agents: [{ agent_id: 'quick-mydesk', role: 'coder', capabilities: ['code'] }] } } : { body: { task_id: 't1' } }))
  await assert.rejects(call('task_dispatch', { agent: 'quick-mydesk', title: '修首页', instruction: '改完跑测试并 git push' }), /role-not-coding/)
  assert.equal(calls.some(c => c.path === '/v1/ctl/dispatch'), false)
  await call('task_dispatch', { agent: 'quick-mydesk', title: '修首页', instruction: '只改 index.css', needs: ['code'] })
  assert.deepEqual(calls.at(-1).json.needs, ['code'])
})

test('fallback tools: list, take (inputs inlined as text), submit (text files as base64)', async () => {
  const { call, calls } = setup((c) => {
    if (c.path === '/v1/ctl/fallback') return { body: { tasks: [{ task_id: 't9' }] } }
    if (c.path === '/v1/ctl/fallback/take') {
      return { body: { task: { task_id: 't9', instruction: 'Summarise.', inputs: [{ name: 'a.txt', from_task: 't9' }, { name: 'b.md', from_task: 't8' }] } } }
    }
    if (c.path === '/v1/ctl/fallback/input') return { raw: `content of ${c.query.get('name')}` }
    return { body: { ok: true } }
  })
  const last = () => calls.at(-1)
  const q = () => Object.fromEntries(last().query.entries())

  assert.deepEqual(await call('fallback_list', { workspaces: ['ws-a', 'ws-b'] }), { tasks: [{ task_id: 't9' }] })
  assert.deepEqual(q(), { id: CONTROLLER, workspaces: 'ws-a,ws-b' })

  const taken = await call('fallback_take', { workspaces: ['ws-a'] })
  const take = calls.find(c => c.path === '/v1/ctl/fallback/take')
  assert.deepEqual(take.json, { workspaces: ['ws-a'] })
  assert.equal(taken.task.instruction, 'Summarise.')
  assert.deepEqual(taken.task.inputs.map(i => i.text), ['content of a.txt', 'content of b.md'])
  const inputs = calls.filter(c => c.path === '/v1/ctl/fallback/input').map(c => Object.fromEntries(c.query.entries()))
  assert.deepEqual(inputs, [
    { id: CONTROLLER, task_id: 't9', name: 'a.txt' },
    { id: CONTROLLER, task_id: 't9', name: 'b.md', from_task: 't8' },
  ], 'an input from an earlier task names that task')

  await call('fallback_submit', { task_id: 't9', status: 'completed', summary: 'Done.', files: [{ name: 'out.md', text: 'é' }] })
  assert.deepEqual([last().path, last().json], ['/v1/ctl/fallback/result', { task_id: 't9', status: 'completed', summary: 'Done.', files: [{ name: 'out.md', base64: b64('é') }] }])
})

test('fallback_take with nothing due returns task null and reads no input', async () => {
  const { call, calls } = setup(() => ({ body: { task: null } }))
  assert.deepEqual(await call('fallback_take'), { task: null })
  assert.equal(calls.length, 1)
})

test('task_dispatch replaces: the answered task is put away once the new one is queued; a running one is only reported', async () => {
  const { call, calls } = setup((c) => {
    if (c.path === '/v1/ctl/dispatch') return { body: { task_id: 'new1', status: 'pending' } }
    if (c.path === '/v1/ctl/ack' && c.json.task_id === 'old1') return { body: { task: { task_id: 'old1', acknowledged: true } } }
    if (c.path === '/v1/ctl/ack') return { status: 409, body: { error: { code: 'task-active', message: 'task is running' } } }
    return { body: {} }
  })
  const out = await call('task_dispatch', { agent: 'pool:research', title: 't', instruction: 'Use the v2 field names.', replaces: 'old1' })
  assert.deepEqual(out, { task_id: 'new1', status: 'pending', replaced: { task_id: 'old1', put_away: true } })
  const sent = calls.find(c => c.path === '/v1/ctl/dispatch').json
  assert.equal('replaces' in sent, false, 'replaces is not sent to the hub')
  assert.deepEqual(calls.at(-1).json, { task_id: 'old1' })
  const busy = await call('task_dispatch', { agent: 'pool:research', title: 't', instruction: 'i', replaces: 'old2' })
  assert.equal(busy.replaced.put_away, false)
  assert.match(busy.replaced.note, /task_cancel/)
})

test('mailbox: task_dispatch asks for the answers to come back to this profile; fallback_* only see what came back here', async () => {
  const base = makeClient((c) => {
    if (c.path === '/v1/ctl/dispatch') return { body: { task_id: 'n1', status: 'pending' } }
    if (c.path === '/v1/ctl/fallback') return { body: { tasks: [] } }
    if (c.path === '/v1/ctl/fallback/take') return { body: { task: null } }
    return { body: {} }
  })
  const tools = new Map(createTools({ client: base.client, profile: 'cloud' }).map(tool => [tool.name, tool]))
  const run = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal })
  await run('task_dispatch', { agent: 'pool:research', title: 't', instruction: 'i' })
  assert.equal(base.calls.find(c => c.path === '/v1/ctl/dispatch').json.reply_to, 'cloud')
  await run('fallback_list', {})
  assert.equal(base.calls.find(c => c.path === '/v1/ctl/fallback').query.get('profile'), 'cloud')
  await run('fallback_take', {})
  assert.equal(base.calls.find(c => c.path === '/v1/ctl/fallback/take').json.profile, 'cloud')
})
