/** Shared fake ctx and temp-dir helpers for the dsh-host-secrets tests. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/** Fake secrets only. */
export const FAKE = {
  OPENAI: 'sk-test-FAKE-0123456789abcdef',
  GITHUB: 'ghp_FAKE_abcdefghijklmnopqrstuvwxyz0123',
  SHORTISH: 'FAKEpass99',
}
export const PASS_ENV = 'DSH_SECRETS_TEST_PASSPHRASE'
export const PASSPHRASE = 'test-master-FAKE-passphrase'

/** A temp DSH home; DSH_HOME points at it so no default path can reach ~/.dsh. */
export async function tempHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-secrets-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  process.env[PASS_ENV] = PASSPHRASE
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

/**
 * Mount the plugin on a fake ctx. Every tool result, thrown message and log line
 * is recorded in `seen` for the leak scan.
 */
export function mount(home, config = {}) {
  const tools = new Map()
  const logs = []
  const listeners = new Map()
  const seen = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    logger: {
      info(...args) { logs.push(args.join(' ')) },
      warn(...args) { logs.push(args.join(' ')) },
      error(...args) { logs.push(args.join(' ')) },
      debug(...args) { logs.push(args.join(' ')) },
    },
    on(name, listener) { listeners.set(name, listener); return () => listeners.delete(name) },
    effect(run) { return run() },
  }
  apply(ctx, {
    vaultPath: join(home, 'secrets.vault'),
    passphraseEnv: PASS_ENV,
    scryptN: 1024,
    ...config,
  })
  async function call(name, args, signal = new AbortController().signal) {
    const definition = tools.get(name)
    assert.ok(definition, `tool ${name} is not registered`)
    try {
      const value = await definition.execute(args, { signal })
      seen.push(JSON.stringify(value))
      // render must work and stay value-free as well
      seen.push(JSON.stringify(definition.output.render(args, value)))
      return value
    } catch (error) {
      seen.push(String(error?.message), String(error?.stack))
      throw error
    }
  }
  return { ctx, tools, logs, listeners, seen, call, vaultPath: join(home, 'secrets.vault') }
}

/** Assert none of the values occur in any recorded output, log, or error. */
export function assertNoLeak(plugin, values = Object.values(FAKE)) {
  const haystack = [...plugin.seen, ...plugin.logs].join('\n')
  for (const value of values) {
    assert.ok(!haystack.includes(value), `secret value leaked (fingerprint ${value.length} chars)`)
  }
}
