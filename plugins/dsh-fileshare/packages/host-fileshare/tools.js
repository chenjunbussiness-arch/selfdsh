/**
 * Agent tools of dsh-host-fileshare:
 *
 *   file_share         temporary download link for one file (or one dsh-hub task output)
 *   file_upload_link   temporary upload link into one folder
 *   file_links         list links (with files received on upload links)
 *   file_link_revoke   end a link now
 *
 * A relative path resolves against the calling session's working directory,
 * which is also an allowed root (unless `includeSessionCwd: false`).
 *
 * @module dsh-host-fileshare/tools
 */

import { ShareError, formatBytes } from './service.js'

const objectSchema = { type: 'object' }
const renderJson = (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }]

function noBase(result) {
  if (result.url !== null) return undefined
  return 'No public address is known yet, so only the path is given. Ask the user to open the DSH web page once (its address is then remembered) or to set publicBaseUrl in the dsh-fileshare config, then create the link again.'
}

function minutesText(iso) {
  const left = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000))
  return left >= 120 ? `${Math.round(left / 60)} h` : `${left} min`
}

/**
 * @param {{ service: ReturnType<import('./service.js').createService>, cwdOf: (exec: any) => Promise<string | undefined> }} deps
 */
export function createTools({ service, cwdOf }) {
  const tools = []
  const define = (def) => tools.push({
    isConcurrencySafe: () => true,
    output: { schema: objectSchema, render: renderJson },
    ...def,
    parameters: { type: 'object', additionalProperties: false, ...def.parameters },
  })

  const guard = async (fn) => {
    try {
      return await fn()
    } catch (error) {
      if (error instanceof ShareError) throw new Error(error.message)
      throw error
    }
  }

  define({
    name: 'file_share',
    description: 'Make a temporary download link for one file so the user can download it in a browser or with curl instead of scp. '
      + 'Give `path` (absolute, or relative to the working directory), or `hub_task` + `name` for an output file of a dsh-hub task. '
      + 'Only files inside allowed directories (the working directory, configured roots) can be shared; secrets-like names (.env, *.key, .ssh, ...) are refused. '
      + 'Directories cannot be shared: pack them first (tar czf / zip) and share the archive. '
      + 'Put the returned `url` in your reply exactly as returned; it is shown only this once. Default lifetime 60 minutes.',
    parameters: {
      properties: {
        path: { type: 'string', description: 'File to share.' },
        hub_task: { type: 'string', description: 'dsh-hub task id whose output to share (with name).' },
        name: { type: 'string', description: 'Output file name of hub_task.' },
        ttl_minutes: { type: 'number', description: 'Lifetime in minutes (default 60, max 10080 = 7 days).' },
        max_downloads: { type: 'integer', minimum: 1, description: 'Downloads allowed (default unlimited until it expires).' },
        note: { type: 'string', description: 'Short label shown in the link list.' },
      },
    },
    async execute(raw, exec) {
      return guard(async () => {
        if (raw?.path === undefined && raw?.hub_task === undefined) throw new ShareError('give path, or hub_task and name')
        const cwd = await cwdOf(exec)
        await service.noteWorkspace(cwd)
        const result = await service.createDownload({
          path: raw?.path, hubTask: raw?.hub_task, name: raw?.name, cwd,
          ttlMinutes: raw?.ttl_minutes, maxDownloads: raw?.max_downloads, note: raw?.note, by: 'agent',
        })
        return {
          id: result.id,
          url: result.url,
          path: result.path,
          file: result.name,
          size: formatBytes(result.size),
          expiresAt: result.expiresAt,
          expiresIn: minutesText(result.expiresAt),
          maxDownloads: result.maxDownloads,
          ...(result.url === null ? { linkPath: result.path, note: noBase(result) } : {}),
        }
      })
    },
  })

  define({
    name: 'file_upload_link',
    description: 'Make a temporary upload link so the user can send files to this machine from a browser (drag and drop page) or with `curl -T file <url>`, instead of scp. '
      + 'Files land in `dir` (absolute or relative to the working directory; created if missing; default: the fileshare inbox). Existing files are never overwritten: a clash becomes "name (1).ext". '
      + 'Put the returned `url` in your reply exactly as returned. Check what arrived with file_links (id). Default lifetime 30 minutes, 20 files, 512 MB.',
    parameters: {
      properties: {
        dir: { type: 'string', description: 'Target folder.' },
        ttl_minutes: { type: 'number', description: 'Lifetime in minutes (default 30, max 1440).' },
        max_files: { type: 'integer', minimum: 1, description: 'Files allowed (default 20).' },
        max_mb: { type: 'number', description: 'Total size allowed in MB (default 512).' },
        note: { type: 'string', description: 'Short label shown in the link list.' },
      },
    },
    async execute(raw, exec) {
      return guard(async () => {
        const cwd = await cwdOf(exec)
        await service.noteWorkspace(cwd)
        const result = await service.createUpload({
          dir: raw?.dir, cwd, ttlMinutes: raw?.ttl_minutes, maxFiles: raw?.max_files, maxMb: raw?.max_mb, note: raw?.note, by: 'agent',
        })
        return {
          id: result.id,
          url: result.url,
          dir: result.path,
          expiresAt: result.expiresAt,
          expiresIn: minutesText(result.expiresAt),
          maxFiles: result.maxFiles,
          maxSize: formatBytes(result.maxBytes),
          ...(result.url !== null ? { curl: `curl -T <file> ${result.url}` } : { linkPath: result.path, note: noBase(result) }),
        }
      })
    },
  })

  define({
    name: 'file_links',
    description: 'List file-share links (newest first) with their state, download counts, and the files received on upload links (name, size, sha256). Tokens and URLs are never listed.',
    parameters: {
      properties: {
        id: { type: 'string', description: 'Only this link.' },
        active_only: { type: 'boolean', description: 'Only links that still work (default false).' },
      },
    },
    async execute(raw) {
      return guard(async () => {
        const links = await service.list({ id: raw?.id, activeOnly: raw?.active_only === true })
        return { count: links.length, links }
      })
    },
  })

  define({
    name: 'file_link_revoke',
    description: 'Revoke a file-share link now (download or upload). Files already received stay where they are.',
    parameters: {
      required: ['id'],
      properties: { id: { type: 'string', description: 'Link id from file_share / file_upload_link / file_links.' } },
    },
    async execute(raw) {
      return guard(async () => {
        const link = await service.revoke(raw?.id)
        return { id: link.id, state: link.state, revokedAt: link.revokedAt }
      })
    },
  })

  return tools
}
