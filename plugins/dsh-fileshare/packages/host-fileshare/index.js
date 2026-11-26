/**
 * dsh-host-fileshare: temporary download and upload links, so files move
 * between a DSH machine and the user without scp.
 *
 * - Tools (agents): file_share, file_upload_link, file_links, file_link_revoke.
 * - Public routes (the token is the credential): /api/fileshare/d/*, /api/fileshare/u/*.
 * - Logged-in routes for the 文件中转 page: /api/fileshare/{hello,links,create,revoke}.
 *
 * See ../../README.md.
 *
 * @module dsh-host-fileshare
 */

import { resolveConfig } from './config.js'
import { createManageRoutes, requireLogin } from './manage.js'
import { createPublicRoutes } from './public.js'
import { createService } from './service.js'
import { LinkStore } from './store.js'
import { createTools } from './tools.js'

export const name = 'dsh-host-fileshare'
export const inject = ['tools']

/**
 * @param {any} ctx - Cordis context with `tools` (and optionally `workingDirectory`, `webServer`, `connection`).
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const warn = (message) => { try { ctx.logger?.warn?.(message) } catch { /* ignore */ } }
  const config = resolveConfig(rawConfig, { warn })
  const store = new LinkStore({ file: config.stateFile, maxActiveLinks: config.maxActiveLinks, keepExpiredMs: config.keepExpiredMs })
  const service = createService({ config, store, logger: ctx.logger })

  /** The calling session's working directory, when the Harness exposes it. */
  const cwdOf = async (exec) => {
    if (exec?.agent === undefined || typeof ctx.get !== 'function') return undefined
    try {
      const wd = ctx.get('workingDirectory')
      if (typeof wd?.ensure !== 'function') return undefined
      return await wd.ensure(exec.agent, exec.signal)
    } catch {
      return undefined
    }
  }

  for (const tool of createTools({ service, cwdOf })) {
    ctx.effect(() => ctx.tools.register(tool))
  }
  mountRoutes(ctx, { service, store, config })
  ctx.logger?.info?.(`dsh-fileshare: links in ${config.stateFile}; public base ${config.publicBaseUrl !== '' ? 'from config' : 'learned from the browser'}; 4 tools registered`)
}

function mountRoutes(ctx, { service, store, config }) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('dsh-fileshare: webServer exposes no register(); links cannot be served')
      return
    }
    const connection = () => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
    const secure = () => webServer.protocol === 'https:'
    for (const route of createPublicRoutes({ store, logger: ctx.logger })) {
      webCtx.effect(() => webServer.register(route), `dsh-fileshare: ${route.path}`)
    }
    for (const route of createManageRoutes({ service, store, config, logger: ctx.logger, secure })) {
      webCtx.effect(() => webServer.register(requireLogin(route, connection)), `dsh-fileshare: ${route.path}`)
    }
    ctx.logger?.info?.('dsh-fileshare: routes mounted at /api/fileshare (public: d/, u/; login: hello, links, create, revoke)')
  })
}
