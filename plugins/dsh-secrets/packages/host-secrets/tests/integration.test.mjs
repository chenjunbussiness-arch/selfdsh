/**
 * Real-process integration tests for dsh-host-secrets.
 *
 * These tests deliberately spawn real child processes and run a real
 * `node:http` server on 127.0.0.1. Nothing about child_process or http is
 * mocked. Only fake secret values are used.
 *
 * Proved here:
 *  - secret_exec: the child really receives the exact plaintext (child-side
 *    sha256 printed and compared against the expected hash, no plaintext in
 *    argv), output is redacted (literal and base64 forms), exit codes/success
 *    are reported, and a failing command reports success:false.
 *  - secret_http: a real local server records the received headers/body and
 *    echoes them back; the server sees the exact plaintext, the tool return
 *    contains no plaintext and does contain [REDACTED:name], and unknown /
 *    malformed placeholders produce the documented errors without leaking.
 *  - logger output (info/warn/error/debug) and thrown errors/stacks contain no
 *    plaintext.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'
import { mount, tempHome } from './helpers.mjs'

// Fake values only. Never use a real credential here.
const API_KEY = 'sk-test-FAKE-0123456789abcdef'
const OTHER = 'ghp_FAKE_abcdefghijklmnopqrstuvwxyz0123'
const VALUES = [API_KEY, OTHER]
const PASS_ENV = 'DSH_SECRETS_TEST_PASSPHRASE'

const sha256hex = text => createHash('sha256').update(text, 'utf8').digest('hex')

/** Literal, base64, base64url and hex forms of the fake values. */
const FORBIDDEN_FORMS = (() => {
  const forms = new Set()
  for (const value of VALUES) {
    forms.add(value)
    const bytes = Buffer.from(value, 'utf8')
    const b64 = bytes.toString('base64')
    forms.add(b64)
    forms.add(b64.replace(/=+$/, ''))
    forms.add(bytes.toString('base64url'))
    forms.add(bytes.toString('hex'))
    forms.add(bytes.toString('hex').toUpperCase())
  }
  forms.delete('')
  return [...forms]
})()

/** Assert that no form of either fake value occurs in `haystack`. */
function assertNoPlaintext(haystack, where) {
  for (const form of FORBIDDEN_FORMS) {
    assert.ok(!haystack.includes(form), `${where} leaked a secret form (${form.length} chars)`)
  }
}

/** Record logger calls with their level, on top of the helper's capture. */
function captureLevels(plugin) {
  const entries = []
  for (const level of ['info', 'warn', 'error', 'debug']) {
    const original = plugin.ctx.logger[level].bind(plugin.ctx.logger)
    plugin.ctx.logger[level] = (...args) => {
      entries.push({ level, text: args.map(String).join(' ') })
      original(...args)
    }
  }
  return entries
}

test('secret_exec: real child receives exact value, output redacted, exit code reported', async (t) => {
  const plugin = mount(await tempHome(t))
  const levels = captureLevels(plugin)
  await plugin.call('secret_set', { name: 'API_KEY', value: API_KEY, description: 'fake exec key' })
  await plugin.call('secret_set', { name: 'OTHER', value: OTHER, description: 'fake exec other' })

  const execTool = plugin.tools.get('secret_exec')

  // (b) The child prints sha256($MY_KEY); no plaintext is put in argv. The
  // expected digest is computed here and compared with what the child saw.
  const hashArgs = {
    command: 'sh',
    args: ['-c', 'printf %s "$MY_KEY" | sha256sum'],
    secrets: { MY_KEY: 'API_KEY', OTHER: 'OTHER' },
  }
  const hashOut = await plugin.call('secret_exec', hashArgs)
  const expectedHash = sha256hex(API_KEY)
  const childHash = hashOut.stdout.trim().split(/\s+/)[0]
  assert.equal(hashOut.success, true)
  assert.equal(hashOut.exitCode, 0)
  assert.equal(hashOut.signal, null)
  assert.equal(childHash, expectedHash, 'child-side sha256 must equal the expected value hash')
  assert.equal(hashOut.stdout.trim(), `${expectedHash}  -`)
  assert.deepEqual(hashOut.injected.map(entry => entry.env), ['MY_KEY', 'OTHER'])
  assert.equal(hashOut.injected[0].fingerprint, expectedHash.slice(0, 8))
  const hashRendered = JSON.stringify(execTool.output.render(hashArgs, hashOut))
  assertNoPlaintext(JSON.stringify(hashOut) + hashRendered, 'secret_exec hash return/render')

  // The printenv child receives both values; the returned output must show
  // redaction markers instead of plaintext.
  const envArgs = {
    command: 'printenv',
    args: ['MY_KEY', 'OTHER'],
    secrets: { MY_KEY: 'API_KEY', OTHER: 'OTHER' },
  }
  const envOut = await plugin.call('secret_exec', envArgs)
  assert.equal(envOut.success, true)
  assert.equal(envOut.exitCode, 0)
  // GNU printenv with names prints values only (one per line).
  assert.equal(envOut.stdout, '[REDACTED:API_KEY]\n[REDACTED:OTHER]\n')
  assert.ok(envOut.stdout.includes('[REDACTED:API_KEY]'))
  assert.ok(envOut.stdout.includes('[REDACTED:OTHER]'))
  assertNoPlaintext(envOut.stdout, 'printenv stdout')
  assert.equal(envOut.stderr, '')
  assert.deepEqual(envOut.truncated, { stdout: false, stderr: false })
  const envRendered = JSON.stringify(execTool.output.render(envArgs, envOut))
  assertNoPlaintext(JSON.stringify(envOut), 'secret_exec printenv return JSON')
  assertNoPlaintext(envRendered, 'secret_exec printenv render')
  assert.ok(envRendered.includes('[REDACTED:API_KEY]'))

  // The documented base64 form is redacted too.
  const b64Args = {
    command: 'sh',
    args: ['-c', 'printf %s "$MY_KEY" | base64'],
    secrets: { MY_KEY: 'API_KEY' },
  }
  const b64Out = await plugin.call('secret_exec', b64Args)
  assert.equal(b64Out.success, true)
  assert.equal(b64Out.exitCode, 0)
  assert.equal(b64Out.stdout.trim(), '[REDACTED:API_KEY]')
  assertNoPlaintext(JSON.stringify(b64Out), 'secret_exec base64 return')
  assert.ok(JSON.stringify(b64Out).includes('[REDACTED:API_KEY]'))

  // A non-zero child exit reports success:false with the real exit code.
  const failOut = await plugin.call('secret_exec', { command: 'sh', args: ['-c', 'exit 3'], secrets: ['API_KEY'] })
  assert.equal(failOut.exitCode, 3)
  assert.equal(failOut.success, false)
  assert.equal(failOut.signal, null)
  assert.equal(failOut.timedOut, false)
  assert.equal(failOut.aborted, false)

  // (c) All logger output and every returned/rendered payload stays clean.
  assert.ok(plugin.logs.length >= 3)
  assert.ok(levels.some(entry => entry.level === 'info'))
  for (const entry of levels) assertNoPlaintext(entry.text, `${entry.level} log`)
  assertNoPlaintext([...plugin.logs, ...levels.map(entry => entry.text), ...plugin.seen].join('\n'), 'logs + results')
  assert.ok(plugin.logs.some(line => line.includes('secret_exec')))

  t.diagnostic(`secret_exec: child sha256=${childHash.slice(0, 16)}… expected=${expectedHash.slice(0, 16)}… match=true`)
  t.diagnostic(`printenv: exit=${envOut.exitCode} success=${envOut.success} stdout=${JSON.stringify(envOut.stdout)}`)
  t.diagnostic(`base64: exit=${b64Out.exitCode} stdout=${JSON.stringify(b64Out.stdout)} (redacted)`)
  t.diagnostic(`exit 3: success=${failOut.success} exitCode=${failOut.exitCode}`)
})

/** Real local HTTP server; records every request and echoes it back. */
async function startEchoServer(t) {
  const received = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ method: request.method, url: request.url, headers: request.headers, body })
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-echo-auth': request.headers.authorization ?? '',
        'x-echo-other': request.headers['x-other'] ?? '',
      })
      response.end(JSON.stringify({
        authorization: request.headers.authorization ?? null,
        other: request.headers['x-other'] ?? null,
        body,
      }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => {
    server.close(resolve)
    server.closeAllConnections?.()
  }))
  return { base: `http://127.0.0.1:${server.address().port}`, received }
}

test('secret_http: real server sees exact plaintext, response redacted, explicit errors', async (t) => {
  const plugin = mount(await tempHome(t))
  const levels = captureLevels(plugin)
  await plugin.call('secret_set', { name: 'API_KEY', value: API_KEY, description: 'fake http key' })
  await plugin.call('secret_set', { name: 'OTHER', value: OTHER, description: 'fake http other' })
  const { base, received } = await startEchoServer(t)

  const args = {
    url: `${base}/echo?key=\${secret:API_KEY}`,
    method: 'POST',
    headers: {
      Authorization: 'Bearer ${secret:API_KEY}',
      'X-Other': '${secret:OTHER}',
    },
    body: '{"other":"${secret:OTHER}","key":"${secret:API_KEY}"}',
  }
  const out = await plugin.call('secret_http', args)

  // (b) The real server received the exact plaintext.
  assert.equal(out.status, 200)
  assert.equal(out.ok, true)
  assert.equal(received.length, 1)
  const seenRequest = received[0]
  assert.equal(seenRequest.method, 'POST')
  assert.equal(seenRequest.headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(seenRequest.headers['x-other'], OTHER)
  assert.equal(seenRequest.body, `{"other":"${OTHER}","key":"${API_KEY}"}`)
  assert.equal(seenRequest.url, `/echo?key=${API_KEY}`)
  assert.equal(sha256hex(seenRequest.headers.authorization), sha256hex(`Bearer ${API_KEY}`))
  assert.equal(sha256hex(seenRequest.body), sha256hex(`{"other":"${OTHER}","key":"${API_KEY}"}`))

  // (a) The tool return has no plaintext and does contain redaction markers.
  const httpTool = plugin.tools.get('secret_http')
  const httpRendered = JSON.stringify(httpTool.output.render(args, out))
  assertNoPlaintext(JSON.stringify(out), 'secret_http return JSON')
  assertNoPlaintext(httpRendered, 'secret_http render')
  assert.ok(out.body.includes('[REDACTED:API_KEY]'))
  assert.ok(out.body.includes('[REDACTED:OTHER]'))
  assert.ok(out.url.includes('[REDACTED:API_KEY]'))
  assert.ok(httpRendered.includes('[REDACTED:API_KEY]'))
  assert.ok(httpRendered.includes('[REDACTED:OTHER]'))
  assert.equal(out.headers['x-echo-auth'], 'Bearer [REDACTED:API_KEY]')
  assert.equal(out.headers['x-echo-other'], '[REDACTED:OTHER]')
  assert.equal(out.redirected, false)
  assert.equal(out.truncated, false)

  // Unknown and malformed placeholders: explicit errors, no leak, no request.
  const errorCases = [
    [() => plugin.call('secret_http', { url: `${base}/unknown`, body: '${secret:NOPE}' }), 'secret not found: NOPE'],
    [() => plugin.call('secret_http', { url: `${base}/malformed`, body: 'ab${secret:}' }), 'malformed placeholder at offset 2 in body'],
    [() => plugin.call('secret_http', { url: `${base}/malformed`, headers: { Authorization: 'Bearer ${secret:API_KEY' } }), 'malformed placeholder at offset 7 in header Authorization'],
  ]
  for (const [invoke, expected] of errorCases) {
    let error
    try {
      await invoke()
    } catch (caught) {
      error = caught
    }
    assert.ok(error instanceof Error, `expected error: ${expected}`)
    assert.equal(error.message, expected)
    assertNoPlaintext(String(error.message), 'thrown error message')
    assertNoPlaintext(String(error.stack), 'thrown error stack')
  }
  assert.equal(received.length, 1, 'placeholder errors must not send a request')

  // (c) Logger output and all captured payloads stay clean.
  assert.ok(plugin.logs.some(line => line.includes('secret_http')))
  assert.ok(levels.some(entry => entry.level === 'info'))
  for (const entry of levels) assertNoPlaintext(entry.text, `${entry.level} log`)
  assertNoPlaintext([...plugin.logs, ...levels.map(entry => entry.text), ...plugin.seen].join('\n'), 'logs + results + errors')

  t.diagnostic(`secret_http: status=${out.status} auth-sha256=${sha256hex(seenRequest.headers.authorization).slice(0, 16)}… body-sha256=${sha256hex(seenRequest.body).slice(0, 16)}… exact-match=true`)
  t.diagnostic(`secret_http return markers: ${['[REDACTED:API_KEY]', '[REDACTED:OTHER]'].filter(marker => JSON.stringify(out).includes(marker)).join(', ')}`)
  t.diagnostic(`placeholder errors: ${errorCases.map(([, expected]) => expected).join(' | ')}`)
})

test('logger levels and thrown error stacks contain no plaintext', async (t) => {
  const plugin = mount(await tempHome(t))
  const levels = captureLevels(plugin)
  await plugin.call('secret_set', { name: 'API_KEY', value: API_KEY, description: 'fake log key' })
  await plugin.call('secret_set', { name: 'OTHER', value: OTHER, description: 'fake log other' })
  await plugin.call('secret_exec', { command: 'sh', args: ['-c', 'printf %s "$API_KEY"; printf %s "$OTHER" >&2'], secrets: ['API_KEY', 'OTHER'] })

  // Thrown errors (message and stack are captured by the fake ctx).
  let thrown
  try {
    await plugin.call('secret_exec', { command: 'sh', args: ['-c', 'true'], secrets: ['NOPE'] })
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof Error)
  assert.equal(thrown.message, 'secret not found: NOPE')
  assertNoPlaintext(String(thrown.message), 'thrown error message')
  assertNoPlaintext(String(thrown.stack), 'thrown error stack')

  // Force the post-execute warn path: without the passphrase the listener must
  // fall back to the original decision and log only a generic warning.
  const savedPassphrase = process.env[PASS_ENV]
  delete process.env[PASS_ENV]
  try {
    const listener = plugin.listeners.get('tools/post-execute')
    assert.ok(listener, 'post-execute listener registered')
    const decision = await listener({ name: 'bash' }, { content: [{ type: 'text', text: API_KEY }] }, async () => ({ kind: 'accept' }))
    assert.deepEqual(decision, { kind: 'accept' })
  } finally {
    process.env[PASS_ENV] = savedPassphrase
  }

  assert.ok(levels.some(entry => entry.level === 'info'), 'info level captured')
  assert.ok(levels.some(entry => entry.level === 'warn'), 'warn level captured')
  for (const entry of levels) assertNoPlaintext(entry.text, `${entry.level} log`)
  assertNoPlaintext([...plugin.logs, ...levels.map(entry => entry.text), ...plugin.seen].join('\n'), 'all logger output + results + errors')

  t.diagnostic(`logger levels seen: ${[...new Set(levels.map(entry => entry.level))].join(', ')}; lines=${levels.length}`)
})
