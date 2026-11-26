/**
 * Configuration of dsh-host-fileshare: defaults, validation, resolved paths.
 *
 * Every key is optional. Paths default under `<DSH home>/fileshare/`, where
 * `<DSH home>` is `$DSH_HOME` or `~/.dsh`.
 *
 * @module dsh-host-fileshare/config
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { DEFAULT_DENY } from './paths.js'
import { checkBaseUrl } from './origin.js'

const MIB = 1024 * 1024

/** Defaults, also listed in cordis.patch.yml. */
export const DEFAULTS = Object.freeze({
  publicBaseUrl: '',
  roots: [],
  includeSessionCwd: true,
  hubArtifactsDir: undefined,
  inboxDir: undefined,
  stateFile: undefined,
  downloadTtlMinutes: 60,
  downloadMaxTtlMinutes: 7 * 24 * 60,
  uploadTtlMinutes: 30,
  uploadMaxTtlMinutes: 24 * 60,
  uploadMaxFiles: 20,
  uploadMaxMb: 512,
  uploadMaxMbCap: 4096,
  maxActiveLinks: 500,
  keepExpiredDays: 7,
  deny: DEFAULT_DENY,
})

function dshHomeOf(raw) {
  const fromEnv = process.env['DSH_HOME']
  if (typeof raw === 'string' && raw !== '') return resolve(raw)
  if (typeof fromEnv === 'string' && fromEnv !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

function expandHome(path) {
  return path.replace(/^~(?=$|[\\/])/, homedir())
}

function absolute(path, base) {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}

function positiveInt(value, fallback, key) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1) throw new Error(`dsh-fileshare: ${key} must be a positive integer`)
  return value
}

/**
 * Resolve the raw cordis config.
 * @param {Record<string, unknown>} [raw]
 * @param {{ warn?: (message: string) => void }} [log]
 */
export function resolveConfig(raw = {}, log = {}) {
  const input = raw ?? {}
  const dshHome = dshHomeOf(input.dshHome)
  const stateDir = join(dshHome, 'fileshare')
  const roots = Array.isArray(input.roots) ? input.roots : DEFAULTS.roots
  if (roots.some(root => typeof root !== 'string' || root.trim() === '')) throw new Error('dsh-fileshare: roots must be a list of directory paths')
  const deny = Array.isArray(input.deny) ? input.deny : DEFAULTS.deny
  if (deny.some(pattern => typeof pattern !== 'string' || pattern === '')) throw new Error('dsh-fileshare: deny must be a list of name patterns')

  let publicBaseUrl = ''
  if (typeof input.publicBaseUrl === 'string' && input.publicBaseUrl.trim() !== '') {
    const checked = checkBaseUrl(input.publicBaseUrl.trim())
    if (checked.ok) publicBaseUrl = checked.base
    else log.warn?.(`dsh-fileshare: publicBaseUrl ignored: ${checked.reason}`)
  }

  const config = {
    dshHome,
    stateDir,
    stateFile: typeof input.stateFile === 'string' && input.stateFile !== '' ? absolute(input.stateFile, dshHome) : join(stateDir, 'links.json'),
    inboxDir: typeof input.inboxDir === 'string' && input.inboxDir !== '' ? absolute(input.inboxDir, dshHome) : join(stateDir, 'inbox'),
    hubArtifactsDir: typeof input.hubArtifactsDir === 'string' && input.hubArtifactsDir !== '' ? absolute(input.hubArtifactsDir, dshHome) : join(dshHome, 'agent-hub', 'artifacts'),
    roots: roots.map(root => absolute(root.trim(), dshHome)),
    includeSessionCwd: input.includeSessionCwd !== false,
    publicBaseUrl,
    deny,
    downloadTtlMinutes: positiveInt(input.downloadTtlMinutes, DEFAULTS.downloadTtlMinutes, 'downloadTtlMinutes'),
    downloadMaxTtlMinutes: positiveInt(input.downloadMaxTtlMinutes, DEFAULTS.downloadMaxTtlMinutes, 'downloadMaxTtlMinutes'),
    uploadTtlMinutes: positiveInt(input.uploadTtlMinutes, DEFAULTS.uploadTtlMinutes, 'uploadTtlMinutes'),
    uploadMaxTtlMinutes: positiveInt(input.uploadMaxTtlMinutes, DEFAULTS.uploadMaxTtlMinutes, 'uploadMaxTtlMinutes'),
    uploadMaxFiles: positiveInt(input.uploadMaxFiles, DEFAULTS.uploadMaxFiles, 'uploadMaxFiles'),
    uploadMaxBytes: positiveInt(input.uploadMaxMb, DEFAULTS.uploadMaxMb, 'uploadMaxMb') * MIB,
    uploadMaxBytesCap: positiveInt(input.uploadMaxMbCap, DEFAULTS.uploadMaxMbCap, 'uploadMaxMbCap') * MIB,
    maxActiveLinks: positiveInt(input.maxActiveLinks, DEFAULTS.maxActiveLinks, 'maxActiveLinks'),
    keepExpiredMs: positiveInt(input.keepExpiredDays, DEFAULTS.keepExpiredDays, 'keepExpiredDays') * 24 * 60 * 60 * 1000,
  }
  if (config.downloadTtlMinutes > config.downloadMaxTtlMinutes) config.downloadTtlMinutes = config.downloadMaxTtlMinutes
  if (config.uploadTtlMinutes > config.uploadMaxTtlMinutes) config.uploadTtlMinutes = config.uploadMaxTtlMinutes
  if (config.uploadMaxBytes > config.uploadMaxBytesCap) config.uploadMaxBytes = config.uploadMaxBytesCap
  return config
}
