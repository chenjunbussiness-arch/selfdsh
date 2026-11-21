/**
 * Tool definitions for dsh-host-secrets. No tool returns a secret value.
 *
 * Every error is thrown as `Error(message)` whose message names at most the
 * secret NAME; exec/http errors are additionally passed through the redactor.
 *
 * @module dsh-host-secrets/tools
 */

import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseTemplate, refsOf, render } from './placeholders.js'
import { createRedactor, redactDeep, truncate } from './redact.js'
import {
  DECRYPT_FAILED, EXPORT_FORMAT, deriveKey, fingerprint, isValidName, newScryptKdf, normalizePayload,
  open_, parseEnvelope, seal, valueLength, writeNewFile,
} from './vault.js'

export const DESCRIPTION_HINT = '建议补充描述 (description)'
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const TAG_RE = /^[^\s,]{1,64}$/
const MAX_VALUE_BYTES = 64 * 1024
const MAX_DESCRIPTION = 4000
const MAX_TAGS = 32
const LIST_DESCRIPTION_CHARS = 60
const COLLECT_CAP_BYTES = 1024 * 1024

// --- validation helpers --------------------------------------------------------

function requireName(raw, key = 'name') {
  if (typeof raw !== 'string' || !isValidName(raw)) {
    throw new Error(`invalid ${key}: must match /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/`)
  }
  return raw
}

function optionalDescription(raw) {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new Error('description must be a string')
  if (raw.length > MAX_DESCRIPTION) throw new Error(`description is longer than ${MAX_DESCRIPTION} characters`)
  return raw
}

function optionalTags(raw) {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.length > MAX_TAGS || raw.some(tag => typeof tag !== 'string' || !TAG_RE.test(tag))) {
    throw new Error(`tags must be an array of at most ${MAX_TAGS} strings of 1-64 characters without spaces or commas`)
  }
  return [...new Set(raw)]
}

function stringRecord(raw, key) {
  if (raw === undefined) return {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${key} must be an object of strings`)
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') throw new Error(`${key}.${name} must be a string`)
  }
  return raw
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest()
}

/** Truncate to N code points and add an ellipsis. */
export function truncateChars(text, max = LIST_DESCRIPTION_CHARS) {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

function item(name, entry, { fullDescription = false } = {}) {
  return {
    name,
    description: fullDescription ? entry.description : truncateChars(entry.description),
    tags: [...entry.tags],
    fingerprint: fingerprint(entry.value),
    length: valueLength(entry.value),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    metaUpdatedAt: entry.metaUpdatedAt,
  }
}

/** Run `body`; rethrow any failure with its message redacted (stack dropped). */
async function guarded(redactor, body) {
  try {
    return await body()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(redactor.redact(message))
  }
}

function timestampName(now = new Date()) {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '')
  return `secrets-export-${iso}.dshvault`
}

function hostAllowed(hostname, allow) {
  if (allow === null) return true
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return allow.some((rule) => {
    const pattern = rule.toLowerCase()
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
    return host === pattern
  })
}

function commandAllowed(command, allow) {
  if (allow === null) return true
  return allow.includes(command) || allow.includes(basename(command))
}

/** Collect a stream up to `cap` bytes; remember whether it overflowed. */
function collector(cap) {
  const chunks = []
  let size = 0
  let overflow = false
  return {
    push(chunk) {
      if (size >= cap) { overflow = true; return }
      const room = cap - size
      if (chunk.length > room) { chunks.push(chunk.subarray(0, room)); size = cap; overflow = true } else { chunks.push(chunk); size += chunk.length }
    },
    get overflow() { return overflow },
    text() { return Buffer.concat(chunks).toString('utf8') },
  }
}

/** Redact then truncate; when collection was capped, drop a tail that could hold a cut value. */
function finishOutput(raw, overflow, redactor, max) {
  let text = raw
  if (overflow && redactor.maxForm > 0) text = text.slice(0, Math.max(0, text.length - redactor.maxForm))
  const out = truncate(redactor.redact(text), max)
  return { text: out.text, truncated: out.truncated || overflow }
}

const objectSchema = { type: 'object' }
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }]

// --- tools -------------------------------------------------------------------

/**
 * Build all tool definitions.
 * @param {{ vault: import('./vault.js').Vault, config: ReturnType<import('./config.js').resolveConfig>, logger: any }} deps
 */
export function createTools({ vault, config, logger }) {
  const log = (message) => { try { logger?.info?.(message) } catch { /* never fail a tool on logging */ } }

  /** Decrypt, pick the named values, drop the rest. Unknown → `secret not found: NAME`. */
  async function pick(names) {
    const { entries } = await vault.load({ requireKey: true })
    const out = new Map()
    for (const name of names) {
      const entry = entries[name]
      if (entry === undefined) throw new Error(`secret not found: ${name}`)
      out.set(name, entry.value)
    }
    return out
  }

  const tools = []
  const define = (def) => tools.push({
    isConcurrencySafe: () => true,
    output: { schema: objectSchema, render: renderJson },
    ...def,
    parameters: { type: 'object', additionalProperties: false, ...def.parameters },
  })

  define({
    name: 'secret_set',
    description: 'Store a secret in the local encrypted vault (create or overwrite). The value is stored literally and can never be read back by any tool; only its fingerprint and length are returned. Add a description so the secret can be found later.',
    parameters: {
      required: ['name', 'value'],
      properties: {
        name: { type: 'string', description: 'Secret name, /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.' },
        value: { type: 'string', description: 'The secret value (non-empty). Stored as given.' },
        description: { type: 'string', description: 'What the secret is for.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering.' },
      },
    },
    async execute(raw, exec) {
      const name = requireName(raw?.name)
      const value = raw?.value
      if (typeof value !== 'string' || value === '') throw new Error('value must be a non-empty string')
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw new Error(`value is larger than ${MAX_VALUE_BYTES} bytes`)
      const description = optionalDescription(raw?.description)
      const tags = optionalTags(raw?.tags)
      const result = await vault.mutate((entries) => {
        const now = new Date().toISOString()
        const previous = entries[name]
        entries[name] = {
          value,
          description: description ?? previous?.description ?? '',
          tags: tags ?? previous?.tags ?? [],
          createdAt: previous?.createdAt ?? now,
          updatedAt: now,
          metaUpdatedAt: description !== undefined || tags !== undefined || previous === undefined ? now : previous.metaUpdatedAt,
        }
        const created = previous === undefined
        const out = { name, fingerprint: fingerprint(value), length: valueLength(value), created }
        if (created && (entries[name].description === '')) out.hint = DESCRIPTION_HINT
        return out
      }, { signal: exec?.signal })
      log(`dsh-secrets: ${result.created ? 'created' : 'updated'} secret ${name}`)
      return result
    },
  })

  define({
    name: 'secret_describe',
    description: 'Change the description and/or tags of a stored secret. The value, fingerprint and updatedAt stay the same; metaUpdatedAt moves.',
    parameters: {
      required: ['name'],
      properties: {
        name: { type: 'string' },
        description: { type: 'string', description: 'New description (replaces the old one).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tag list (replaces the old one).' },
      },
    },
    async execute(raw, exec) {
      const name = requireName(raw?.name)
      const description = optionalDescription(raw?.description)
      const tags = optionalTags(raw?.tags)
      if (description === undefined && tags === undefined) throw new Error('give description and/or tags')
      const result = await vault.mutate((entries) => {
        const entry = entries[name]
        if (entry === undefined) throw new Error(`secret not found: ${name}`)
        if (description !== undefined) entry.description = description
        if (tags !== undefined) entry.tags = tags
        entry.metaUpdatedAt = new Date().toISOString()
        const full = item(name, entry, { fullDescription: true })
        return { name, fingerprint: full.fingerprint, length: full.length, description: full.description, tags: full.tags, updatedAt: full.updatedAt, metaUpdatedAt: full.metaUpdatedAt }
      }, { signal: exec?.signal })
      log(`dsh-secrets: described secret ${name}`)
      return result
    },
  })

  define({
    name: 'secret_list',
    description: 'List stored secrets (names and metadata only, never values). Filter by exact tag and/or a case-insensitive keyword in name or description.',
    parameters: {
      properties: {
        tag: { type: 'string', description: 'Only secrets carrying this tag.' },
        query: { type: 'string', description: 'Case-insensitive substring of name or description.' },
      },
    },
    async execute(raw) {
      if (raw?.tag !== undefined && typeof raw.tag !== 'string') throw new Error('tag must be a string')
      if (raw?.query !== undefined && typeof raw.query !== 'string') throw new Error('query must be a string')
      const { entries } = await vault.load()
      const query = raw?.query?.toLowerCase()
      const items = Object.keys(entries).sort().filter((name) => {
        const entry = entries[name]
        if (raw?.tag !== undefined && !entry.tags.includes(raw.tag)) return false
        if (query !== undefined && query !== '' && !name.toLowerCase().includes(query) && !entry.description.toLowerCase().includes(query)) return false
        return true
      }).map(name => item(name, entries[name]))
      return { items, total: items.length }
    },
  })

  define({
    name: 'secret_delete',
    description: 'Delete a stored secret.',
    parameters: { required: ['name'], properties: { name: { type: 'string' } } },
    async execute(raw, exec) {
      const name = requireName(raw?.name)
      await vault.mutate((entries) => {
        if (entries[name] === undefined) throw new Error(`secret not found: ${name}`)
        delete entries[name]
      }, { signal: exec?.signal })
      log(`dsh-secrets: deleted secret ${name}`)
      return { name, deleted: true }
    },
  })

  define({
    name: 'secret_rename',
    description: 'Rename a stored secret. Fails when the new name exists unless overwrite is true.',
    parameters: {
      required: ['from', 'to'],
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'boolean', description: 'Replace an existing secret named `to`. Default false.' },
      },
    },
    async execute(raw, exec) {
      const from = requireName(raw?.from, 'from')
      const to = requireName(raw?.to, 'to')
      if (raw?.overwrite !== undefined && typeof raw.overwrite !== 'boolean') throw new Error('overwrite must be a boolean')
      const overwrite = raw?.overwrite === true
      const result = await vault.mutate((entries) => {
        if (entries[from] === undefined) throw new Error(`secret not found: ${from}`)
        if (from === to) return { result: { from, to, overwritten: false }, skipWrite: true }
        const exists = entries[to] !== undefined
        if (exists && !overwrite) throw new Error(`secret already exists: ${to} (pass overwrite: true to replace it)`)
        entries[to] = entries[from]
        delete entries[from]
        return { from, to, overwritten: exists }
      }, { signal: exec?.signal })
      log(`dsh-secrets: renamed secret ${from} -> ${to}`)
      return result
    },
  })

  define({
    name: 'secret_check',
    description: 'Check whether a secret exists, and optionally whether a candidate value equals it (timing-safe). Returns the fingerprint, never the value.',
    parameters: {
      required: ['name'],
      properties: {
        name: { type: 'string' },
        value: { type: 'string', description: 'Candidate value to compare.' },
      },
    },
    async execute(raw) {
      const name = requireName(raw?.name)
      if (raw?.value !== undefined && typeof raw.value !== 'string') throw new Error('value must be a string')
      const { entries } = await vault.load()
      const entry = entries[name]
      if (entry === undefined) return raw?.value === undefined ? { name, exists: false } : { name, exists: false, matches: false }
      const out = { name, exists: true, fingerprint: fingerprint(entry.value) }
      if (raw?.value !== undefined) out.matches = timingSafeEqual(sha256(entry.value), sha256(raw.value))
      return out
    },
  })

  define({
    name: 'secret_exec',
    description: 'Run a command (no shell; use command "bash" with args ["-c", "..."] for one) with stored secrets injected as environment variables. Every injected value, and its base64/url/hex forms, is replaced by [REDACTED:NAME] in the returned stdout/stderr. Redaction is best effort: a command that transforms the value can still reveal it.',
    parameters: {
      required: ['command', 'secrets'],
      properties: {
        command: { type: 'string', description: 'Executable name or path.' },
        args: { type: 'array', items: { type: 'string' } },
        secrets: {
          description: 'Secret names to inject under their own names, or a map {ENV_NAME: secretName}.',
          oneOf: [
            { type: 'array', items: { type: 'string' } },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
        },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra non-secret environment variables.' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
    },
    async execute(raw, exec) {
      const command = raw?.command
      if (typeof command !== 'string' || command === '') throw new Error('command must be a non-empty string')
      if (!commandAllowed(command, config.execAllowedCommands)) throw new Error(`command not allowed by execAllowedCommands: ${basename(command)}`)
      const args = raw?.args ?? []
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('args must be an array of strings')
      const mapping = {}
      const secretsRaw = raw?.secrets
      if (Array.isArray(secretsRaw)) {
        for (const name of secretsRaw) {
          requireName(name, 'secret name')
          if (!ENV_NAME_RE.test(name)) throw new Error(`secret name ${name} is not a valid env var name; use the mapping form {ENV_NAME: "${name}"}`)
          mapping[name] = name
        }
      } else if (secretsRaw !== null && typeof secretsRaw === 'object') {
        for (const [envName, name] of Object.entries(secretsRaw)) {
          if (!ENV_NAME_RE.test(envName)) throw new Error(`invalid env var name: ${envName}`)
          requireName(name, 'secret name')
          mapping[envName] = name
        }
      } else {
        throw new Error('secrets must be an array of names or an object {ENV_NAME: secretName}')
      }
      if (Object.keys(mapping).length === 0) throw new Error('secrets must name at least one secret')
      const extraEnv = stringRecord(raw?.env, 'env')
      for (const key of Object.keys(extraEnv)) if (key in mapping) throw new Error(`env.${key} collides with an injected secret`)
      if (raw?.cwd !== undefined && typeof raw.cwd !== 'string') throw new Error('cwd must be a string')
      if (raw?.timeoutMs !== undefined && (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1)) throw new Error('timeoutMs must be a positive integer')
      const timeoutMs = Math.min(raw?.timeoutMs ?? config.execTimeoutMs, config.execMaxTimeoutMs)

      const values = await pick([...new Set(Object.values(mapping))])
      const redactor = createRedactor(values)
      return guarded(redactor, async () => {
        const childEnv = { ...process.env, ...extraEnv }
        for (const [envName, name] of Object.entries(mapping)) childEnv[envName] = values.get(name)
        const out = await runChild(command, args, { env: childEnv, cwd: raw?.cwd, timeoutMs, signal: exec?.signal })
        const stdout = finishOutput(out.stdout.text(), out.stdout.overflow, redactor, config.maxOutputChars)
        const stderr = finishOutput(out.stderr.text(), out.stderr.overflow, redactor, config.maxOutputChars)
        log(`dsh-secrets: secret_exec ${basename(command)} exit=${String(out.exitCode)} secrets=${[...values.keys()].join(',')}`)
        return {
          command: redactor.redact(command),
          args: args.map(arg => redactor.redact(arg)),
          exitCode: out.exitCode,
          signal: out.signal,
          success: out.exitCode === 0 && !out.timedOut && !out.aborted,
          timedOut: out.timedOut,
          aborted: out.aborted,
          stdout: stdout.text,
          stderr: stderr.text,
          truncated: { stdout: stdout.truncated, stderr: stderr.truncated },
          injected: Object.entries(mapping).map(([env, name]) => ({ env, name, fingerprint: fingerprint(values.get(name)) })),
        }
      })
    },
  })

  define({
    name: 'secret_http',
    description: 'Send an HTTP(S) request with ${secret:NAME} placeholders in url, header values and body replaced by stored secrets. $${secret: is a literal "${secret:". The response headers and body are returned with secret values redacted.',
    parameters: {
      required: ['url'],
      properties: {
        url: { type: 'string' },
        method: { type: 'string', description: 'Default GET.' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
    },
    async execute(raw, exec) {
      if (typeof raw?.url !== 'string' || raw.url === '') throw new Error('url must be a non-empty string')
      const method = (raw?.method ?? 'GET')
      if (typeof method !== 'string' || !/^[A-Za-z]{1,16}$/.test(method)) throw new Error('method must be an HTTP method name')
      const headersIn = stringRecord(raw?.headers, 'headers')
      if (raw?.body !== undefined && typeof raw.body !== 'string') throw new Error('body must be a string')
      if (raw?.timeoutMs !== undefined && (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1)) throw new Error('timeoutMs must be a positive integer')

      const urlParts = parseTemplate(raw.url, 'url')
      const headerParts = Object.entries(headersIn).map(([key, value]) => [key, parseTemplate(value, `header ${key}`)])
      const bodyParts = raw?.body === undefined ? undefined : parseTemplate(raw.body, 'body')
      const refs = new Set([...refsOf(urlParts), ...headerParts.flatMap(([, parts]) => refsOf(parts)), ...bodyParts === undefined ? [] : refsOf(bodyParts)])
      const values = refs.size === 0 ? new Map() : await pick([...refs])
      const redactor = createRedactor(values)
      const lookup = name => values.get(name)

      return guarded(redactor, async () => {
        const url = render(urlParts, lookup)
        let parsed
        try { parsed = new URL(url) } catch { throw new Error('url is not a valid URL') }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('only http: and https: URLs are allowed')
        if (!hostAllowed(parsed.hostname, config.httpAllowedHosts)) throw new Error(`host not allowed by httpAllowedHosts: ${parsed.hostname}`)
        const headers = {}
        for (const [key, parts] of headerParts) headers[key] = render(parts, lookup)
        const body = bodyParts === undefined ? undefined : render(bodyParts, lookup)
        const timeoutMs = raw?.timeoutMs ?? config.httpTimeoutMs
        const timeout = AbortSignal.timeout(timeoutMs)
        const signal = exec?.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
        let response
        try {
          response = await fetch(parsed, { method: method.toUpperCase(), headers, body, signal, redirect: config.httpFollowRedirects ? 'follow' : 'manual' })
        } catch (error) {
          if (timeout.aborted) throw new Error(`request timed out after ${timeoutMs} ms`)
          if (exec?.signal?.aborted) throw new Error('request aborted')
          const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'error'
          throw new Error(`request failed: ${String(cause)}`)
        }
        const collected = collector(COLLECT_CAP_BYTES)
        if (response.body) {
          for await (const chunk of response.body) {
            collected.push(Buffer.from(chunk))
            if (collected.overflow) break
          }
        }
        const text = finishOutput(collected.text(), collected.overflow, redactor, config.maxOutputChars)
        const outHeaders = redactDeep(Object.fromEntries(response.headers.entries()), redactor)
        log(`dsh-secrets: secret_http ${method.toUpperCase()} ${parsed.hostname} status=${response.status} secrets=${[...values.keys()].join(',')}`)
        return {
          status: response.status,
          ok: response.ok,
          url: redactor.redact(response.url || url),
          redirected: response.redirected,
          headers: outHeaders,
          body: text.text,
          truncated: text.truncated,
        }
      })
    },
  })

  define({
    name: 'secret_export',
    description: 'Write all secrets (values, descriptions, tags) into one file encrypted with the given passphrase, independent of the vault key. If path is a directory, a timestamped secrets-export-*.dshvault file is created in it. Losing the passphrase makes the file unreadable.',
    parameters: {
      required: ['path', 'passphrase'],
      properties: {
        path: { type: 'string', description: 'Existing directory, or a new file path.' },
        passphrase: { type: 'string', description: 'At least 8 characters.' },
      },
    },
    async execute(raw) {
      if (typeof raw?.path !== 'string' || raw.path === '') throw new Error('path must be a non-empty string')
      if (typeof raw?.passphrase !== 'string' || raw.passphrase.length < 8) throw new Error('passphrase must be at least 8 characters')
      let target = resolve(raw.path)
      try {
        if ((await stat(target)).isDirectory()) target = join(target, timestampName())
        else throw new Error(`file already exists: ${target}`)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      const { entries } = await vault.load({ requireKey: true })
      const kdf = newScryptKdf(config.scrypt)
      const key = await deriveKey(kdf, Buffer.from(raw.passphrase, 'utf8'), { cache: false })
      const text = `${JSON.stringify(seal(EXPORT_FORMAT, kdf, key, { exportedAt: new Date().toISOString(), entries }), undefined, 2)}\n`
      key.fill(0)
      try {
        await writeNewFile(target, text)
      } catch (error) {
        if (error?.code === 'EEXIST') throw new Error(`file already exists: ${target}`)
        if (error?.code === 'ENOENT') throw new Error(`directory does not exist for ${target}`)
        throw new Error(`cannot write export file ${target}: ${error?.code ?? 'error'}`)
      }
      const count = Object.keys(entries).length
      log(`dsh-secrets: exported ${count} secret(s) to ${target}`)
      return { path: target, sha256: createHash('sha256').update(text, 'utf8').digest('hex'), entries: count, bytes: Buffer.byteLength(text, 'utf8') }
    },
  })

  define({
    name: 'secret_import',
    description: 'Import a file made by secret_export. strategy "merge" adds secrets (onConflict "skip" (default) or "overwrite" for existing names); "replace" makes the vault exactly the imported set.',
    parameters: {
      required: ['path', 'passphrase', 'strategy'],
      properties: {
        path: { type: 'string' },
        passphrase: { type: 'string' },
        strategy: { type: 'string', enum: ['merge', 'replace'] },
        onConflict: { type: 'string', enum: ['overwrite', 'skip'], description: 'merge only; default skip.' },
      },
    },
    async execute(raw, exec) {
      if (typeof raw?.path !== 'string' || raw.path === '') throw new Error('path must be a non-empty string')
      if (typeof raw?.passphrase !== 'string' || raw.passphrase === '') throw new Error('passphrase must be a non-empty string')
      const strategy = raw?.strategy
      if (strategy !== 'merge' && strategy !== 'replace') throw new Error('strategy must be "merge" or "replace"')
      const onConflict = raw?.onConflict ?? 'skip'
      if (onConflict !== 'skip' && onConflict !== 'overwrite') throw new Error('onConflict must be "overwrite" or "skip"')
      if (strategy === 'replace' && raw?.onConflict !== undefined) throw new Error('onConflict applies to strategy "merge" only')
      const path = resolve(raw.path)
      let text
      try { text = await readFile(path, 'utf8') } catch (error) { throw new Error(`cannot read import file ${path}: ${error?.code ?? 'error'}`) }
      const envelope = parseEnvelope(text, EXPORT_FORMAT)
      if (envelope.kdf.name !== 'scrypt') throw new Error('export file must use scrypt')
      const key = await deriveKey(envelope.kdf, Buffer.from(raw.passphrase, 'utf8'), { cache: false })
      let incoming
      try {
        incoming = normalizePayload(open_(envelope, key)).entries
      } catch (error) {
        throw new Error(error?.message === DECRYPT_FAILED ? DECRYPT_FAILED : 'import file payload is malformed')
      } finally {
        key.fill(0)
      }
      const result = await vault.mutate((entries) => {
        const counts = { strategy, added: 0, overwritten: 0, skipped: 0, removed: 0 }
        if (strategy === 'replace') {
          for (const name of Object.keys(entries)) {
            if (incoming[name] === undefined) counts.removed += 1
            else counts.overwritten += 1
            delete entries[name]
          }
          for (const [name, entry] of Object.entries(incoming)) {
            entries[name] = entry
          }
          counts.added = Object.keys(incoming).length - counts.overwritten
          return counts
        }
        for (const [name, entry] of Object.entries(incoming)) {
          if (entries[name] === undefined) { entries[name] = entry; counts.added += 1 } else if (onConflict === 'overwrite') { entries[name] = entry; counts.overwritten += 1 } else counts.skipped += 1
        }
        return counts
      }, { signal: exec?.signal })
      log(`dsh-secrets: imported (${strategy}) added=${result.added} overwritten=${result.overwritten} skipped=${result.skipped} removed=${result.removed}`)
      return result
    },
  })

  return tools
}

/**
 * Spawn without a shell; SIGTERM then SIGKILL on timeout/abort.
 * @returns {Promise<{exitCode: number|null, signal: string|null, timedOut: boolean, aborted: boolean, stdout: any, stderr: any}>}
 */
function runChild(command, args, { env, cwd, timeoutMs, signal }) {
  return new Promise((done, fail) => {
    if (signal?.aborted) { fail(new Error('aborted')); return }
    const stdout = collector(COLLECT_CAP_BYTES)
    const stderr = collector(COLLECT_CAP_BYTES)
    let timedOut = false
    let aborted = false
    let killTimer
    let child
    try {
      child = spawn(command, args, { env, cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      fail(new Error(`failed to start command: ${error?.code ?? 'error'}`))
      return
    }
    const stop = () => {
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { child.kill('SIGKILL') }, 2000)
      killTimer.unref?.()
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    const onAbort = () => { aborted = true; stop() }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    let started = true
    child.on('error', (error) => {
      started = false
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      fail(new Error(`failed to start command: ${error?.code ?? 'error'}`))
    })
    child.on('close', (code, sig) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      if (!started) return
      done({ exitCode: code, signal: sig, timedOut, aborted, stdout, stderr })
    })
  })
}
