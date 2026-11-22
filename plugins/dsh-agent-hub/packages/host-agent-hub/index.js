/**
 * Host half of `dsh-agent-hub`: this DSH is a CONTROLLER of the standalone
 * dsh-hub (protocol `dsh-agent/2.0`, docs/DSH-HUB-PROTOCOL-v2.md section 6).
 *
 * It keeps no task state and runs no sweeper: the hub (services/dsh-hub) owns
 * tasks, leases, retries and artifacts. This plugin only
 *   - reads its config (hubUrl, controllerId, caFile, timeoutMs, tokenEnv, envFile, proxy)
 *     and the controller token: process env `<tokenEnv>` (default DSH_HUB_TOKEN)
 *     first, else the same key in the .env-format file `envFile` (default
 *     <DSH home>/agent-hub/controller.env). Never <DSH home>/.env for a DSH_* name:
 *     DSH refuses to start when its own .env sets any DSH_* variable, so that file
 *     is skipped with a warning (hub-client.js resolveConfig),
 *   - registers the 11 DSH-only control tools (tools.js -> /v1/ctl/*),
 *   - mounts the login-guarded read-only panel routes /api/agent-hub/admin/*
 *     (bridge.js), which forward to the hub.
 *
 * A missing config or token never stops the plugin from loading: it warns, and
 * every tool call / panel request answers with a clear `hub-not-configured` /
 * `hub-token-missing` error. The token value is never logged.
 *
 * @module host-agent-hub
 */

import { ADMIN_BASE, createRoutes, requireLogin } from './bridge.js'
import { createHubClient, tokenMissingMessage } from './hub-client.js'
import { createTools } from './tools.js'

export const name = 'dsh-host-agent-hub'
export const inject = ['tools']

/** v1 keys that now belong to the hub (`<DSH home>/agent-hub/hub.json` on the hub machine). */
const V1_KEYS = ['dataDir', 'publicUrl', 'offlineAfterMs', 'sweepIntervalMs', 'maxRetries', 'maxPendingRequests', 'maxResultBytes']

export function apply(ctx, config = {}) {
  const env = globalThis.process?.env ?? {}
  const client = createHubClient({
    hubUrl: config.hubUrl,
    controllerId: config.controllerId,
    caFile: config.caFile,
    timeoutMs: config.timeoutMs,
    tokenEnv: config.tokenEnv,
    envFile: config.envFile,
    proxy: config.proxy,
    env,
    logger: ctx.logger,
  })

  const ignored = V1_KEYS.filter(key => config[key] !== undefined)
  if (ignored.length > 0) ctx.logger.warn(`agent-hub: config ${ignored.join(', ')} ignored (v1 settings; the standalone hub owns them now)`)
  for (const problem of client.config.problems) ctx.logger.warn(`agent-hub: ${problem}`)
  for (const warning of client.config.warnings) ctx.logger.warn(`agent-hub: ${warning}`)
  if (!client.config.ok) ctx.logger.warn('agent-hub: not configured; tools and panel will answer hub-not-configured until cordis.patch.yml is fixed')
  // Only the SOURCE of the token is logged, never its value.
  const source = client.tokenSource()
  const { tokenEnv, envFile } = client.config
  if (source === undefined) ctx.logger.warn(`agent-hub: ${tokenMissingMessage(client.config)}; tools and panel will answer hub-token-missing (issue one on the hub: node server.mjs controller add ${client.config.controllerId || '<controllerId>'})`)
  else ctx.logger.info(`agent-hub: controller token from ${source === 'env' ? `environment variable ${tokenEnv}` : `${envFile} (${tokenEnv})`}`)

  for (const tool of createTools({ client })) ctx.effect(() => ctx.tools.register(tool))

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') {
        ctx.logger.warn('agent-hub: webServer exposes no register(); panel routes are not mounted')
        return
      }
      const { adminRoutes } = createRoutes({ client, logger: ctx.logger })
      const connection = () => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
      for (const route of adminRoutes) webCtx.effect(() => webServer.register(requireLogin(route, connection)), `agent-hub: ${route.path}`)
      ctx.logger.info(`agent-hub: mounted ${ADMIN_BASE}/* (login, read-only, forwarded to the hub)`)
    })
  }
  const route = client.route()
  const via = client.config.ok && route.via !== 'direct' ? ` via proxy ${route.via}` : ''
  const target = client.config.ok ? `${client.config.hubUrl} as ${client.config.controllerId}${via}` : 'an unconfigured hub'
  ctx.logger.info(`agent-hub: 11 control tools registered (agent_*, task_*); controller of ${target}`)
}
