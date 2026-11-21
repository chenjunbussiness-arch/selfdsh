/**
 * Encrypted vault storage: envelope crypto, key derivation, permission checks,
 * atomic writes, and in-process + cross-process write serialization.
 *
 * Nothing in this module logs, and no error message it throws contains a secret
 * value, a passphrase, or key material.
 *
 * @module dsh-host-secrets/vault
 */

import { createCipheriv, createDecipheriv, createHash, hkdf, randomBytes, scrypt } from 'node:crypto'
import { constants as fsc } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export const VAULT_FORMAT = 'dsh-secrets-vault'
export const EXPORT_FORMAT = 'dsh-secrets-export'
export const VERSION = 1
export const CIPHER = 'aes-256-gcm'
export const DECRYPT_FAILED = 'decryption failed: wrong passphrase or corrupted file'
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/
const GROUP_OTHER_BITS = 0o077
const HKDF_INFO = 'dsh-secrets-vault-v1'
const SCRYPT_MAXMEM = 64 * 1024 * 1024

/** @param {string} name */
export function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name)
}

/** First 8 hex chars of sha256(value). */
export function fingerprint(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)
}

/** Value length in Unicode code points. */
export function valueLength(value) {
  return [...value].length
}

// --- key derivation ----------------------------------------------------------

/** Derived keys, keyed by a digest of (kdf params, key material). Never plaintext entries. */
const keyCache = new Map()
const KEY_CACHE_MAX = 16

function cacheKey(kdf, material) {
  return createHash('sha256').update(JSON.stringify(canonicalKdf(kdf))).update('\0').update(material).digest('hex')
}

function scryptAsync(secret, salt, keyLen, params) {
  return new Promise((ok, fail) => {
    scrypt(secret, salt, keyLen, { ...params, maxmem: SCRYPT_MAXMEM }, (error, key) => {
      if (error) fail(new Error('key derivation failed'))
      else ok(key)
    })
  })
}

function hkdfAsync(material, salt, keyLen) {
  return new Promise((ok, fail) => {
    hkdf('sha256', material, salt, HKDF_INFO, keyLen, (error, key) => {
      if (error) fail(new Error('key derivation failed'))
      else ok(Buffer.from(key))
    })
  })
}

/**
 * Derive (or fetch from cache) the 32-byte key for a kdf header.
 * @param {object} kdf - header kdf object.
 * @param {Buffer} material - passphrase bytes or keyfile content.
 */
export async function deriveKey(kdf, material, { cache = true } = {}) {
  const id = cache ? cacheKey(kdf, material) : undefined
  if (id !== undefined && keyCache.has(id)) return keyCache.get(id)
  const salt = Buffer.from(kdf.salt, 'base64')
  let key
  if (kdf.name === 'scrypt') key = await scryptAsync(material, salt, kdf.keyLen, { N: kdf.N, r: kdf.r, p: kdf.p })
  else if (kdf.name === 'keyfile') key = await hkdfAsync(material, salt, kdf.keyLen)
  else throw new Error(`unsupported kdf: ${String(kdf.name)}`)
  if (id !== undefined) {
    if (keyCache.size >= KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value)
    keyCache.set(id, key)
  }
  return key
}

/** Test hook: drop all cached derived keys. */
export function clearKeyCache() {
  keyCache.clear()
}

export function newScryptKdf({ N, r, p }) {
  return { name: 'scrypt', N, r, p, salt: randomBytes(16).toString('base64'), keyLen: 32 }
}

export function newKeyfileKdf() {
  return { name: 'keyfile', hkdf: 'sha256', salt: randomBytes(16).toString('base64'), keyLen: 32 }
}

/** The kdf fields in a fixed order (the AAD must not depend on key order on disk). */
function canonicalKdf(kdf) {
  if (kdf?.name === 'scrypt') return { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: kdf.salt, keyLen: kdf.keyLen }
  if (kdf?.name === 'keyfile') return { name: 'keyfile', hkdf: kdf.hkdf, salt: kdf.salt, keyLen: kdf.keyLen }
  throw new Error('unsupported kdf in file header')
}

function aadOf(header) {
  return Buffer.from(JSON.stringify([header.format, header.version, canonicalKdf(header.kdf), header.cipher, header.nonce]), 'utf8')
}

// --- envelope ----------------------------------------------------------------

/**
 * Encrypt a payload object into an envelope.
 * @param {string} format - VAULT_FORMAT or EXPORT_FORMAT.
 * @param {object} kdf - kdf header.
 * @param {Buffer} key - 32-byte key.
 * @param {object} payload - JSON-serializable plaintext.
 */
export function seal(format, kdf, key, payload) {
  const header = { format, version: VERSION, kdf: canonicalKdf(kdf), cipher: CIPHER, nonce: randomBytes(12).toString('base64') }
  const cipher = createCipheriv(CIPHER, key, Buffer.from(header.nonce, 'base64'), { authTagLength: 16 })
  cipher.setAAD(aadOf(header))
  const plain = Buffer.from(JSON.stringify(payload), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  plain.fill(0)
  return { ...header, tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
}

/**
 * Parse and structurally validate an envelope (no decryption).
 * @param {string} text
 * @param {string} format - expected format.
 */
export function parseEnvelope(text, format) {
  let doc
  try { doc = JSON.parse(text) } catch { throw new Error(`file is not a ${format} file (invalid JSON)`) }
  const ok = doc !== null && typeof doc === 'object'
    && doc.format === format && doc.version === VERSION && doc.cipher === CIPHER
    && typeof doc.nonce === 'string' && typeof doc.tag === 'string' && typeof doc.ciphertext === 'string'
    && doc.kdf !== null && typeof doc.kdf === 'object' && typeof doc.kdf.salt === 'string' && doc.kdf.keyLen === 32
  if (!ok) throw new Error(`file is not a ${format} v${VERSION} file`)
  if (doc.kdf.name === 'scrypt') {
    const { N, r, p } = doc.kdf
    if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || N > 2 ** 20 || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
      throw new Error('file header has invalid scrypt parameters')
    }
  } else if (doc.kdf.name !== 'keyfile') {
    throw new Error('file header has an unsupported kdf')
  }
  return doc
}

/**
 * Decrypt an envelope; any authentication failure becomes DECRYPT_FAILED.
 * @returns {object} the plaintext payload.
 */
export function open_(envelope, key) {
  let plain
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64')
    const tag = Buffer.from(envelope.tag, 'base64')
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('bad sizes')
    const decipher = createDecipheriv(CIPHER, key, nonce, { authTagLength: 16 })
    decipher.setAAD(aadOf(envelope))
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()])
  } catch {
    throw new Error(DECRYPT_FAILED)
  }
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error(DECRYPT_FAILED)
  } finally {
    plain.fill(0)
  }
}

/** Validate a decrypted payload and return a clean `{ entries }` object. */
export function normalizePayload(payload) {
  const entries = payload?.entries
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('decrypted payload is malformed')
  const out = Object.create(null)
  for (const [name, entry] of Object.entries(entries)) {
    if (!isValidName(name) || typeof entry?.value !== 'string' || entry.value === '') throw new Error('decrypted payload has an invalid entry')
    const now = new Date().toISOString()
    out[name] = {
      value: entry.value,
      description: typeof entry.description === 'string' ? entry.description : '',
      tags: Array.isArray(entry.tags) ? entry.tags.filter(tag => typeof tag === 'string') : [],
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : now,
      metaUpdatedAt: typeof entry.metaUpdatedAt === 'string' ? entry.metaUpdatedAt : (typeof entry.updatedAt === 'string' ? entry.updatedAt : now),
    }
  }
  return { entries: out }
}

// --- files -------------------------------------------------------------------

/** Refuse a file with group/other permission bits. */
export async function assertPrivateFile(path, label) {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
  if (process.platform !== 'win32' && (info.mode & GROUP_OTHER_BITS) !== 0) {
    const mode = (info.mode & 0o777).toString(8).padStart(4, '0')
    throw new Error(`${label} ${path} is accessible by group/other (mode ${mode}); run "chmod 600 ${path}" first`)
  }
  return info
}

async function fsyncDir(dir) {
  let handle
  try {
    handle = await open(dir, 'r')
    await handle.sync()
  } catch {
    // Not supported everywhere (e.g. Windows); the rename itself is still atomic.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Atomic write: `wx` tmp sibling with mode 0600, write, fsync, rename, fsync dir.
 * @param {string} path
 * @param {string} text
 */
export async function atomicWrite(path, text) {
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  let handle
  try {
    handle = await open(temp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
  } catch (error) {
    await handle?.close().catch(() => {})
    await unlink(temp).catch(() => {})
    throw error
  }
  await fsyncDir(dirname(path))
}

/**
 * Write a new file that must not exist yet (`wx`), mode 0600, fsync.
 * @returns {Promise<void>}
 */
export async function writeNewFile(path, text) {
  const handle = await open(path, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsyncDir(dirname(path))
}

// --- locking -----------------------------------------------------------------

/** In-process mutex per resolved vault path (shared by every Vault instance). */
const chains = new Map()

function withMutex(key, run) {
  const previous = chains.get(key) ?? Promise.resolve()
  const result = previous.then(run, run)
  const tail = result.then(() => {}, () => {})
  chains.set(key, tail)
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return result
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function acquireLock(lockPath, { timeoutMs, staleMs, signal }) {
  const deadline = Date.now() + timeoutMs
  let delay = 5
  for (;;) {
    try {
      const handle = await open(lockPath, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() })) } finally { await handle.close() }
      return
    } catch (error) {
      if (error?.code !== 'EEXIST') throw new Error(`cannot create lock file ${lockPath}: ${error?.code ?? 'error'}`)
    }
    // Someone holds it: break it when stale (old, or its owner is gone).
    try {
      const info = await stat(lockPath)
      let owner
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')) } catch { owner = undefined }
      const old = Date.now() - info.mtimeMs > staleMs
      const dead = owner !== undefined && owner.pid !== process.pid && !pidAlive(owner.pid)
      if (old || dead) {
        await unlink(lockPath).catch(() => {})
        continue
      }
    } catch {
      continue // vanished between open and stat: retry immediately
    }
    if (signal?.aborted) throw new Error('aborted while waiting for the vault lock')
    if (Date.now() >= deadline) throw new Error(`timed out waiting for vault lock ${lockPath}`)
    await new Promise(ok => setTimeout(ok, delay))
    delay = Math.min(delay * 2, 100)
  }
}

// --- vault -------------------------------------------------------------------

/**
 * One encrypted vault file.
 *
 * Decrypted entries are returned to the caller for the duration of one
 * operation and are never kept on the instance.
 */
export class Vault {
  /**
   * @param {object} options
   * @param {string} options.path
   * @param {'passphrase-env'|'keyfile'} options.keySource
   * @param {string} options.passphraseEnv
   * @param {string} options.keyfilePath
   * @param {{N:number,r:number,p:number}} options.scrypt
   * @param {number} options.lockTimeoutMs
   * @param {number} options.lockStaleMs
   * @param {Record<string,string|undefined>} [options.env]
   */
  constructor(options) {
    this.path = resolve(options.path)
    this.lockPath = `${this.path}.lock`
    this.keySource = options.keySource
    this.passphraseEnv = options.passphraseEnv
    this.keyfilePath = resolve(options.keyfilePath)
    this.scrypt = options.scrypt
    this.lockTimeoutMs = options.lockTimeoutMs
    this.lockStaleMs = options.lockStaleMs
    this.env = options.env ?? process.env
  }

  /** The kdf name this configuration expects in the header. */
  get kdfName() {
    return this.keySource === 'keyfile' ? 'keyfile' : 'scrypt'
  }

  /** Read the master key material (passphrase bytes or keyfile content). */
  async keyMaterial() {
    if (this.keySource === 'keyfile') {
      try {
        await assertPrivateFile(this.keyfilePath, 'keyfile')
      } catch (error) {
        if (error?.code === 'ENOENT') throw new Error(`master key missing: keyfile not found at ${this.keyfilePath}`)
        throw error
      }
      const raw = await readFile(this.keyfilePath)
      const text = raw.toString('utf8').trim()
      if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex')
      if (/^[A-Za-z0-9+/]{43}=$/.test(text)) {
        const bytes = Buffer.from(text, 'base64')
        if (bytes.length === 32) return bytes
      }
      if (raw.length >= 32) return raw
      throw new Error('keyfile is too short: need 32 raw bytes, 64 hex characters or base64 of 32 bytes')
    }
    const passphrase = this.env[this.passphraseEnv]
    if (typeof passphrase !== 'string' || passphrase === '') {
      throw new Error(`master key missing: set environment variable ${this.passphraseEnv}`)
    }
    return Buffer.from(passphrase, 'utf8')
  }

  /** Whether the vault file exists. */
  async exists() {
    try {
      await stat(this.path)
      return true
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }

  /** Check the vault directory: refuse one writable by group/other. */
  async assertDir() {
    const dir = dirname(this.path)
    const info = await stat(dir)
    if (process.platform !== 'win32' && (info.mode & 0o022) !== 0) {
      const mode = (info.mode & 0o777).toString(8).padStart(4, '0')
      throw new Error(`vault directory ${dir} is writable by group/other (mode ${mode}); run "chmod 700 ${dir}" first`)
    }
  }

  /**
   * Read and decrypt. Returns `{ entries, kdf }`; a missing vault is empty and
   * needs no key unless `requireKey`.
   */
  async load({ requireKey = false } = {}) {
    let text
    try {
      await assertPrivateFile(this.path, 'vault file')
      await this.assertDir()
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') {
        if (requireKey) await this.keyMaterial()
        return { entries: Object.create(null), kdf: undefined }
      }
      throw error
    }
    const envelope = parseEnvelope(text, VAULT_FORMAT)
    if (envelope.kdf.name !== this.kdfName) {
      throw new Error(`vault uses kdf "${envelope.kdf.name}" but keySource is "${this.keySource}"`)
    }
    const key = await deriveKey(envelope.kdf, await this.keyMaterial())
    const payload = normalizePayload(open_(envelope, key))
    return { entries: payload.entries, kdf: envelope.kdf }
  }

  /** Encrypt and atomically write `entries` with `kdf` (fresh nonce). */
  async store(entries, kdf) {
    const material = await this.keyMaterial()
    const useKdf = kdf ?? (this.keySource === 'keyfile' ? newKeyfileKdf() : newScryptKdf(this.scrypt))
    const key = await deriveKey(useKdf, material)
    const envelope = seal(VAULT_FORMAT, useKdf, key, { entries })
    await atomicWrite(this.path, `${JSON.stringify(envelope, undefined, 2)}\n`)
  }

  /**
   * Serialized read-modify-write. `change(entries)` mutates in place and returns
   * a result; return `{ result, write: false }` semantics via `skipWrite`.
   * @template T
   * @param {(entries: object) => T | Promise<T>} change
   * @param {{signal?: AbortSignal}} [options]
   * @returns {Promise<T>}
   */
  mutate(change, { signal } = {}) {
    return withMutex(this.path, async () => {
      if (signal?.aborted) throw new Error('aborted')
      const dir = dirname(this.path)
      try {
        await stat(dir)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        await mkdir(dir, { recursive: true, mode: 0o700 })
      }
      await acquireLock(this.lockPath, { timeoutMs: this.lockTimeoutMs, staleMs: this.lockStaleMs, signal })
      try {
        const { entries, kdf } = await this.load({ requireKey: true })
        const outcome = await change(entries)
        if (outcome?.skipWrite !== true) await this.store(entries, kdf)
        return outcome?.skipWrite === true ? outcome.result : outcome
      } finally {
        await unlink(this.lockPath).catch(() => {})
      }
    })
  }
}
