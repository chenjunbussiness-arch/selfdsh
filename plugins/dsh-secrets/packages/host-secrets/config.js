/**
 * Hand-written config validation for dsh-host-secrets.
 * @module dsh-host-secrets/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** `<DSH_HOME or ~/.dsh>`. */
export function dshHome(env = process.env) {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

const KEYS = new Set([
  'vaultPath', 'keySource', 'passphraseEnv', 'envFile', 'keyfilePath', 'scryptN', 'scryptR', 'scryptP',
  'maxOutputChars', 'execTimeoutMs', 'execMaxTimeoutMs', 'execAllowedCommands', 'httpAllowedHosts',
  'httpTimeoutMs', 'httpFollowRedirects', 'redactToolOutput', 'redactMinLength', 'lockTimeoutMs', 'lockStaleMs',
])

function int(raw, key, fallback, min, max) {
  if (raw === undefined || raw === null) return fallback
  if (!Number.isInteger(raw) || raw < min || raw > max) throw new Error(`dsh-host-secrets config: ${key} must be an integer in [${min}, ${max}]`)
  return raw
}

function bool(raw, key, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'boolean') throw new Error(`dsh-host-secrets config: ${key} must be a boolean`)
  return raw
}

function str(raw, key, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'string' || raw === '') throw new Error(`dsh-host-secrets config: ${key} must be a non-empty string`)
  return raw
}

function list(raw, key) {
  if (raw === undefined || raw === null) return null
  if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string' || item === '')) {
    throw new Error(`dsh-host-secrets config: ${key} must be an array of non-empty strings or null`)
  }
  return [...raw]
}

/**
 * Validate and fill defaults.
 * @param {Record<string, unknown> | undefined} raw
 * @param {Record<string, string | undefined>} [env]
 */
export function resolveConfig(raw, env = process.env) {
  const config = raw ?? {}
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('dsh-host-secrets config must be an object')
  for (const key of Object.keys(config)) {
    if (!KEYS.has(key)) throw new Error(`dsh-host-secrets config: unknown key ${key}`)
  }
  const home = dshHome(env)
  const keySource = config.keySource ?? 'passphrase-env'
  if (keySource !== 'passphrase-env' && keySource !== 'keyfile') {
    throw new Error('dsh-host-secrets config: keySource must be "passphrase-env" or "keyfile"')
  }
  const scryptN = int(config.scryptN, 'scryptN', 32768, 1024, 1048576)
  if ((scryptN & (scryptN - 1)) !== 0) throw new Error('dsh-host-secrets config: scryptN must be a power of two')
  const execTimeoutMs = int(config.execTimeoutMs, 'execTimeoutMs', 60_000, 100, 86_400_000)
  const execMaxTimeoutMs = int(config.execMaxTimeoutMs, 'execMaxTimeoutMs', 600_000, 100, 86_400_000)
  return {
    vaultPath: resolve(str(config.vaultPath, 'vaultPath', join(home, 'secrets.vault'))),
    keySource,
    passphraseEnv: str(config.passphraseEnv, 'passphraseEnv', 'DSH_SECRETS_PASSPHRASE'),
    // false = only the process environment; a string = that dotenv file; default <DSH home>/.env
    envFile: config.envFile === false ? null : resolve(str(config.envFile, 'envFile', join(home, '.env'))),
    keyfilePath: resolve(str(config.keyfilePath, 'keyfilePath', join(home, 'secrets.key'))),
    scrypt: {
      N: scryptN,
      r: int(config.scryptR, 'scryptR', 8, 1, 32),
      p: int(config.scryptP, 'scryptP', 1, 1, 16),
    },
    maxOutputChars: int(config.maxOutputChars, 'maxOutputChars', 65_536, 256, 10_000_000),
    execTimeoutMs: Math.min(execTimeoutMs, execMaxTimeoutMs),
    execMaxTimeoutMs,
    execAllowedCommands: list(config.execAllowedCommands, 'execAllowedCommands'),
    httpAllowedHosts: list(config.httpAllowedHosts, 'httpAllowedHosts'),
    httpTimeoutMs: int(config.httpTimeoutMs, 'httpTimeoutMs', 30_000, 100, 3_600_000),
    httpFollowRedirects: bool(config.httpFollowRedirects, 'httpFollowRedirects', false),
    redactToolOutput: bool(config.redactToolOutput, 'redactToolOutput', true),
    redactMinLength: int(config.redactMinLength, 'redactMinLength', 8, 1, 4096),
    lockTimeoutMs: int(config.lockTimeoutMs, 'lockTimeoutMs', 10_000, 10, 600_000),
    lockStaleMs: int(config.lockStaleMs, 'lockStaleMs', 30_000, 100, 3_600_000),
  }
}
