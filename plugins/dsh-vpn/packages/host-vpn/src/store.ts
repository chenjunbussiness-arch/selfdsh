/**
 * Profile and secret storage.
 *
 * Layout under `<dir>` (default `<DSH home>/vpn`, mode 0700):
 *
 *   profiles.json      every profile, no secret in it (0600)
 *   secrets/<id>       one file per profile holding the password or token URL (0600)
 *   run.json           the running connection, for cleanup after a crash (0600)
 *
 * Why files and not `ctx.credentials`: the credential service is the model-key
 * store (`$DSH_HOME/.credentials.yaml`), its host-side read-back of a value is not
 * confirmed in the rc.3 API facts, and a VPN password has no business in the file
 * that the LLM settings page rewrites. The {@link SecretStore} seam keeps this a
 * one-class swap if that changes.
 *
 * Reads never return a secret: the only method that does is
 * {@link ProfileStore.readSecret}, which only the connection manager calls.
 *
 * @module host-vpn/store
 */

import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { StoredProfile, ValidatedProfile } from './validate.ts'
import { PROFILE_ID, ValidationError, newProfileId, parseHost, parsePort } from './validate.ts'

/** A profile as every read endpoint returns it. */
export interface PublicProfile extends StoredProfile {
  /** Whether a password / token URL is stored. The value is never exposed. */
  readonly secretConfigured: boolean
}

/** Where secret values live. */
export interface SecretStore {
  has(id: string): Promise<boolean>
  read(id: string): Promise<string | undefined>
  write(id: string, value: string): Promise<void>
  remove(id: string): Promise<void>
}

/** Thrown for an id that is not stored. */
export class NotFoundError extends Error {
  constructor(readonly id: string) {
    super(`profile ${id} not found`)
    this.name = 'NotFoundError'
  }
}

/** Most profiles one installation keeps. */
const MAX_PROFILES = 32

/**
 * Write a file atomically with a private mode.
 *
 * The rename is retried with a backoff: on Windows `rename` over a file that is
 * being read fails with EPERM (HANDOFF §7.5), and the tests run there. If every
 * retry fails the content is written in place, which is still a single small
 * write.
 * @param path - target.
 * @param text - contents.
 */
export async function writePrivate(path: string, text: string): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(4).toString('hex')}`
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await rename(temp, path)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
        await rm(temp, { force: true })
        throw error
      }
      await new Promise<void>(resolve => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
  await rm(temp, { force: true })
}

/** Secret files under `<dir>/secrets`. */
export class FileSecretStore implements SecretStore {
  constructor(private readonly dir: string) {}

  private path(id: string): string {
    // The id pattern forbids separators, so this cannot leave the directory.
    if (!PROFILE_ID.test(id)) throw new ValidationError('id', 'invalid profile id')
    return join(this.dir, id)
  }

  async has(id: string): Promise<boolean> {
    return (await this.read(id)) !== undefined
  }

  async read(id: string): Promise<string | undefined> {
    try {
      const value = await readFile(this.path(id), 'utf8')
      return value === '' ? undefined : value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(id: string, value: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await writePrivate(this.path(id), value)
  }

  async remove(id: string): Promise<void> {
    await rm(this.path(id), { force: true })
  }
}

/** Profile persistence. */
export class ProfileStore {
  private cache: StoredProfile[] | undefined
  /** Serialises writers so two requests cannot interleave a read-modify-write. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly dir: string,
    private readonly secrets: SecretStore = new FileSecretStore(join(dir, 'secrets')),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private get file(): string {
    return join(this.dir, 'profiles.json')
  }

  /** Create the private directory. */
  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    // `mkdir` leaves an existing directory's mode alone; tighten it.
    await chmod(this.dir, 0o700).catch(() => {})
  }

  private async load(): Promise<StoredProfile[]> {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { profiles?: unknown }
      this.cache = Array.isArray(parsed.profiles) ? (parsed.profiles as StoredProfile[]) : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.cache = []
    }
    return this.cache
  }

  private async save(profiles: StoredProfile[]): Promise<void> {
    await this.ensure()
    await writePrivate(this.file, `${JSON.stringify({ version: 1, profiles }, undefined, 2)}\n`)
    this.cache = profiles
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => {})
    return next
  }

  private async publicOf(profile: StoredProfile): Promise<PublicProfile> {
    return { ...profile, secretConfigured: await this.secrets.has(profile.id) }
  }

  /** Every profile, without secrets. */
  async list(): Promise<PublicProfile[]> {
    const profiles = await this.load()
    return Promise.all(profiles.map(profile => this.publicOf(profile)))
  }

  /** One profile, without its secret. */
  async get(id: string): Promise<StoredProfile | undefined> {
    return (await this.load()).find(profile => profile.id === id)
  }

  /** The stored secret. Only the connection manager calls this. */
  async readSecret(id: string): Promise<string | undefined> {
    return this.secrets.read(id)
  }

  /**
   * Create or update a profile.
   * @param input - validated request.
   * @returns the stored profile (no secret).
   * @throws {NotFoundError} when `input.id` names nothing.
   * @throws {ValidationError} for a name clash, a missing secret on create, or a token-url update that lacks a gateway.
   */
  upsert(input: ValidatedProfile): Promise<PublicProfile> {
    return this.exclusive(async () => {
      const profiles = [...await this.load()]
      const now = this.clock().toISOString()
      const existing = input.id === undefined ? undefined : profiles.find(profile => profile.id === input.id)
      if (input.id !== undefined && existing === undefined) throw new NotFoundError(input.id)
      if (profiles.some(profile => profile.name === input.fields.name && profile.id !== existing?.id)) {
        throw new ValidationError('name', `a profile named "${input.fields.name}" already exists`)
      }
      if (existing === undefined && profiles.length >= MAX_PROFILES) throw new ValidationError('name', `at most ${String(MAX_PROFILES)} profiles`)
      if (existing === undefined && input.secret === undefined && input.fields.type !== 'custom') {
        throw new ValidationError('secret', input.fields.type === 'password' ? 'a password is required' : 'a token URL is required')
      }
      if (existing !== undefined && existing.type !== input.fields.type && input.secret === undefined && input.fields.type !== 'custom') {
        throw new ValidationError('secret', 'changing the type needs a new secret')
      }
      let fields = input.fields
      if (fields.type === 'token-url' && input.secret === undefined) {
        // The gateway is derived from the stored URL; an update without a new URL keeps it.
        if (existing?.type !== 'token-url') throw new ValidationError('secret', 'a token URL is required')
        fields = { ...fields, host: parseHost(existing.host), port: parsePort(existing.port) }
      }
      const profile: StoredProfile = {
        ...fields,
        id: existing?.id ?? newProfileId(() => randomBytes(4).toString('hex')),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      if (input.secret !== undefined) await this.secrets.write(profile.id, input.secret)
      await this.save(existing === undefined ? [...profiles, profile] : profiles.map(entry => (entry.id === profile.id ? profile : entry)))
      return this.publicOf(profile)
    })
  }

  /**
   * Delete a profile and its secret.
   * @param id - profile id.
   * @throws {NotFoundError} when it does not exist.
   */
  remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const profiles = await this.load()
      if (!profiles.some(profile => profile.id === id)) throw new NotFoundError(id)
      await this.save(profiles.filter(profile => profile.id !== id))
      await this.secrets.remove(id)
    })
  }
}
