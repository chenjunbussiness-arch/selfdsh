/**
 * Host half of `dsh-agent-hub`: this DSH is a CONTROLLER of the standalone
 * dsh-hub (protocol `dsh-agent/2.0`, docs/DSH-HUB-PROTOCOL-v2.md section 6).
 *
 * It keeps no task state and runs no sweeper: the hub (services/dsh-hub) owns
 * tasks, leases, retries and artifacts. This plugin only
 *   - resolves its connection settings (hub-client.js resolveConfig), each one
 *     separately: cordis.patch.yml config > process environment > envFile
 *     (default <DSH home>/agent-hub/controller.env) > default:
 *       hubUrl        DSH_HUB_URL             (bare 203.0.113.10 -> https://203.0.113.10:7891)
 *       controllerId  DSH_HUB_CONTROLLER_ID
 *       proxy         DSH_HUB_PROXY           (off/direct/none = direct, env, http://h:p; default direct)
 *       caFile        DSH_HUB_CAFILE
 *     and the controller token <tokenEnv> (default DSH_HUB_TOKEN: process env, then envFile).
 *     controller.env is re-read on every call, so editing it needs no restart.
 *     Never <DSH home>/.env for a DSH_* name: DSH refuses to start when its own
 *     .env sets any DSH_* variable, so that file is skipped with a warning,
 *   - registers the DSH-only control tools (tools.js -> /v1/ctl/*),
 *   - keeps this DSH on the cloud channel (sync.js): local router tasks are
 *     registered on the hub and kept up to date (stage, session, result), and
 *     hub events become 【进度提醒】 lines in the 作战室,
 *   - mounts the login-guarded read-only panel routes /api/agent-hub/admin/*
 *     (bridge.js), which forward to the hub.
 *
 * A missing config or token never stops the plugin from loading: it warns, and
 * every tool call / panel request answers with a clear `hub-not-configured` /
 * `hub-token-missing` error. The token value is never logged (only its source).
 *
 * @module host-agent-hub
 */

import { basename, join } from 'node:path'
import { ADMIN_BASE, createRoutes, requireLogin } from './bridge.js'
import { createHubClient, dshHomeDir, tokenMissingMessage } from './hub-client.js'
import { createSync } from './sync.js'
import { TOOL_NAMES, createTools } from './tools.js'

export const name = 'dsh-host-agent-hub'
export const inject = ['tools']

/** v1 keys that now belong to the hub (`<DSH home>/agent-hub/hub.json` on the hub machine). */
const V1_KEYS = ['dataDir', 'publicUrl', 'offlineAfterMs', 'sweepIntervalMs', 'maxRetries', 'maxPendingRequests', 'maxResultBytes']

/** `hubUrl=... (<source>), controllerId=... (<source>), proxy=..., caFile=...` (no secrets: proxy is masked). */
export function describeSources(config) {
  const s = config.sources ?? {}
  const proxy = config.proxyMode === 'invalid' ? 'invalid' : (config.proxy ?? 'direct')
  return [
    `hubUrl=${config.hubUrl ?? '(not set)'} (${s.hubUrl})`,
    `controllerId=${config.controllerId || '(not set)'} (${s.controllerId})`,
    `proxy=${proxy} (${s.proxy})`,
    `caFile=${config.caFile ?? '(none)'} (${s.caFile})`,
  ].join(', ') + (s.envFile ? `; envFile ${s.envFile}` : '')
}

/**
 * This DSH's profile name: config `dshProfile`, else the profile dsh launched (`ctx.profileContext`),
 * else the folder name when the process runs inside <DSH home>/profiles/<name>.
 */
export function profileName(ctx, config, cwd = globalThis.process?.cwd?.() ?? '') {
  const ok = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)
  if (ok(config.dshProfile)) return config.dshProfile
  let launched
  try { launched = ctx.profileContext?.name } catch { launched = undefined }
  if (ok(launched)) return launched
  const parts = cwd.split(/[\\/]+/)
  const at = parts.lastIndexOf('profiles')
  return at >= 0 && ok(parts[at + 1]) ? parts[at + 1] : (ok(basename(cwd)) ? basename(cwd) : 'default')
}

/** Start the cloud-channel sync (sync.js) unless `sync: false`. */
function startSync(ctx, config, client, env) {
  const options = config.sync === false ? { mirror: false, notices: false } : { ...(typeof config.sync === 'object' ? config.sync : {}) }
  if (options.mirror === false && options.notices === false) { ctx.logger.info('agent-hub: cloud sync off (sync: false)'); return }
  if (!client.config.ok || !client.hasToken()) { ctx.logger.info('agent-hub: cloud sync waits for a configured hub and token'); return }
  const profile = profileName(ctx, config)
  const get = name => () => { try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined } catch { return undefined } }
  const sync = createSync({
    client, logger: ctx.logger, profile, options,
    router: get('hostRouter'), sessions: get('sessionQuery'),
    stateFile: join(dshHomeDir(env), 'agent-hub', `sync-${profile}.json`),
  })
  ctx.effect(() => sync.start(), 'agent-hub: cloud sync')
  ctx.logger.info(`agent-hub: cloud sync on for profile ${profile} (local router tasks -> hub${options.notices === false ? '' : '; hub events -> 作战室'})`)
}

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
  const resolved = client.config // one snapshot for the startup log (also logs "X is shadowed" notices once)
  for (const problem of resolved.problems) ctx.logger.warn(`agent-hub: ${problem}`)
  for (const warning of resolved.warnings) ctx.logger.warn(`agent-hub: ${warning}`)
  if (!resolved.ok) ctx.logger.warn(`agent-hub: not configured; tools and panel will answer hub-not-configured. ${resolved.setupHint ?? 'Fix the problems above (cordis.patch.yml or controller.env).'}`)
  ctx.logger.info(`agent-hub: config ${describeSources(resolved)}`)
  // Only the SOURCE of the token is logged, never its value.
  const source = client.tokenSource()
  const { tokenEnv, envFile } = resolved
  if (source === undefined) ctx.logger.warn(`agent-hub: ${tokenMissingMessage(resolved)}; tools and panel will answer hub-token-missing (issue one on the hub: node server.mjs controller add ${resolved.controllerId || '<controllerId>'})`)
  else ctx.logger.info(`agent-hub: controller token from ${source === 'env' ? `environment variable ${tokenEnv}` : `${envFile} (${tokenEnv})`}`)

  for (const tool of createTools({ client, profile: profileName(ctx, config) })) ctx.effect(() => ctx.tools.register(tool))
  startSync(ctx, config, client, env)

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
  const via = resolved.ok && route.via !== 'direct' ? ` via proxy ${route.via}` : ''
  const target = resolved.ok ? `${resolved.hubUrl} as ${resolved.controllerId}${via}` : 'an unconfigured hub'
  ctx.logger.info(`agent-hub: ${TOOL_NAMES.length} control tools registered (agent_*, task_*, fallback_*); controller of ${target}`)
}
