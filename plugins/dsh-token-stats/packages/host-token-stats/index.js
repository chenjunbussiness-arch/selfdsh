/**
 * Host half of `dsh-token-stats`.
 *
 * Mounts a read-only aggregator over `<DSH home>/sessions/<project>/<session>/session.v4.jsonl.zstd`
 * and one same-origin GET route on `ctx.webServer`. It adds no tool and writes
 * nothing: the session logs stay exactly as the Harness wrote them.
 *
 * @module host-token-stats
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { BRIDGE_BASE, createRoutes } from './bridge.js'
import { UsageStore } from './scanner.js'

/** Stable plugin name. */
export const name = 'host-token-stats'

/** No required services: `webServer` is injected optionally below. */
export const inject = []

/**
 * Activate the plugin.
 * @param {object} ctx - Cordis plugin context (logger / effect / inject).
 * @param {{ sessionsDir?: string, ttlMs?: number, warmupDelayMs?: number }} [config] - plugin config; every key optional.
 */
export function apply(ctx, config = {}) {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const root = config.sessionsDir === undefined ? join(home, 'sessions') : resolve(config.sessionsDir)
  const store = new UsageStore({
    root,
    logger: ctx.logger,
    ttlMs: typeof config.ttlMs === 'number' ? config.ttlMs : undefined,
  })

  // Warm the cache off the boot path so the first sidebar paint can already be warm.
  const warmupDelayMs = typeof config.warmupDelayMs === 'number' ? config.warmupDelayMs : 800
  ctx.effect(() => {
    const timer = setTimeout(() => {
      store.document({ force: true }).then(
        (document) => {
          const performance = document.performance
          ctx.logger.info(`token-stats: warm-up scanned ${document.source.sessionFiles} session files, `
            + `${document.source.usageEvents} usage events, ${document.totals.billed} billed tokens in ${performance.firstScanMs}ms`)
        },
        (error) => { ctx.logger.warn(`token-stats: warm-up failed: ${error instanceof Error ? error.message : String(error)}`) },
      )
    }, warmupDelayMs)
    return () => clearTimeout(timer)
  }, 'token-stats: warm-up cache')

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        ctx.logger.warn('host-token-stats: webServer exposes no register(); the HTTP bridge is not mounted')
        return
      }
      for (const route of createRoutes({ store, logger: ctx.logger })) {
        webCtx.effect(() => webServer.register(route), `host-token-stats: ${route.path}`)
      }
      ctx.logger.info(`host-token-stats: read-only usage bridge mounted at ${BRIDGE_BASE}/summary (sessions: ${root})`)
    })
  } else {
    ctx.logger.warn('host-token-stats: this Harness does not expose ctx.inject(); the HTTP bridge is not mounted')
  }
}
