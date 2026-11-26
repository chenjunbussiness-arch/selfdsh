/**
 * Data source of the page: the host plugin's logged-in routes under
 * `/api/fileshare` (see host-fileshare/manage.js). POSTs carry the
 * `x-dsh-fileshare: 1` header the host requires.
 */

export const ROUTE_BASE = '/api/fileshare'

export type LinkKind = 'download' | 'upload'
export type LinkState = 'active' | 'expired' | 'revoked' | 'used-up'

export interface ReceivedFile {
  readonly name: string
  readonly size: number
  readonly sha256: string
  readonly at: string
}

export interface LinkView {
  readonly id: string
  readonly kind: LinkKind
  readonly state: LinkState
  readonly name: string
  readonly path: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly by: string
  readonly note?: string
  readonly revokedAt?: string
  readonly size?: number
  readonly downloads?: number
  readonly maxDownloads?: number | null
  readonly lastAccessAt?: string
  readonly maxFiles?: number
  readonly maxBytes?: number
  readonly receivedBytes?: number
  readonly files?: readonly ReceivedFile[]
}

export interface Overview {
  readonly generatedAt: string
  readonly base: string | null
  readonly baseSource: 'config' | 'browser' | 'none'
  readonly roots: readonly string[]
  readonly droppedRoots: readonly { path: string; reason: string }[]
  readonly defaults: {
    readonly downloadTtlMinutes: number
    readonly downloadMaxTtlMinutes: number
    readonly uploadTtlMinutes: number
    readonly uploadMaxTtlMinutes: number
    readonly uploadMaxFiles: number
    readonly uploadMaxMb: number
    readonly inboxDir: string
  }
  readonly links: readonly LinkView[]
}

/** A created link: the view plus its one-time `url` (null when no public base is known) and `path`. */
export interface Created extends LinkView {
  readonly url: string | null
}

export class SourceError extends Error {
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'SourceError'
    this.status = status
  }
}

async function call<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${ROUTE_BASE}/${path}`, payload === undefined
      ? { method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal }
      : {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-dsh-fileshare': '1' },
          body: JSON.stringify(payload),
          signal,
        })
  } catch (error) {
    throw new SourceError(error instanceof Error ? error.message : String(error))
  }
  const text = await response.text()
  let body: unknown
  try { body = text.trim() === '' ? undefined : JSON.parse(text) } catch { body = undefined }
  if (!response.ok) {
    const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message
    throw new SourceError(typeof message === 'string' ? message : `HTTP ${response.status}`, response.status)
  }
  return body as T
}

export function fetchOverview(signal?: AbortSignal): Promise<Overview> {
  return call<Overview>('links', undefined, signal)
}

export function hello(): Promise<{ base: string | null }> {
  return call('hello', {})
}

export function createDownload(input: { path: string; ttlMinutes: number; maxDownloads?: number; note?: string }): Promise<Created> {
  return call<Created>('create', { kind: 'download', ...input })
}

export function createUpload(input: { dir?: string; ttlMinutes: number; maxFiles?: number; maxMb?: number; note?: string }): Promise<Created> {
  return call<Created>('create', { kind: 'upload', ...input })
}

export function revoke(id: string): Promise<LinkView> {
  return call<LinkView>('revoke', { id })
}
