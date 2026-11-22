/**
 * dsh-host-secrets: local encrypted secret vault ("write and use, never read").
 *
 * Registers the secret_* tools and, when available and enabled, a global
 * `tools/post-execute` listener that redacts known secret values from the
 * text content of every tool result. When the Harness exposes `webServer`, it
 * also mounts the read-only, login-guarded dashboard bridge
 * (`GET /api/secrets/summary`, `GET /api/secrets/list`, see bridge.js), which
 * serves metadata, fingerprints and lengths only. See ../../DESIGN.md and
 * ../../docs/DASHBOARD.md.
 *
 * @module dsh-host-secrets
 */

import { BRIDGE_BASE, createRoutes, requireLogin } from './bridge.js'
import { resolveConfig } from './config.js'
import { createRedactor } from './redact.js'
import { createTools } from './tools.js'
import { createEnvSource } from './env-file.js'
import { Vault } from './vault.js'

export const name = 'dsh-host-secrets'
export const inject = ['tools']

/**
 * Build the post-execute listener (exported for tests).
 * @param {Vault} vault
 * @param {{redactMinLength: number}} config
 * @param {any} logger
 */
export function createOutputRedactor(vault, config, logger) {
  let warned = false
  return async (_exec, result, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'accept' || Object.hasOwn(decision, 'value')) return decision
      const content = decision.content ?? result?.content
      if (!Array.isArray(content) || !content.some(block => block?.type === 'text' && typeof block.text === 'string' && block.text !== '')) return decision
      if (!(await vault.exists())) return decision
      const { entries } = await vault.load()
      const pairs = Object.entries(entries)
        .filter(([, entry]) => [...entry.value].length >= config.redactMinLength)
        .map(([key, entry]) => [key, entry.value])
      const redactor = createRedactor(pairs)
      if (redactor.empty) return decision
      let changed = false
      const next_ = content.map((block) => {
        if (block?.type !== 'text' || typeof block.text !== 'string') return block
        const text = redactor.redact(block.text)
        if (text === block.text) return block
        changed = true
        return { ...block, text }
      })
      if (!changed) return decision
      return { kind: 'accept', content: next_, ...decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {} }
    } catch {
      if (!warned) {
        warned = true
        try { logger?.warn?.('dsh-secrets: output redaction skipped (vault unavailable or key missing)') } catch { /* ignore */ }
      }
      return decision
    }
  }
}

/**
 * @param {any} ctx - Cordis context with `tools`.
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const vault = new Vault({
    path: config.vaultPath,
    keySource: config.keySource,
    passphraseEnv: config.passphraseEnv,
    keyfilePath: config.keyfilePath,
    scrypt: config.scrypt,
    lockTimeoutMs: config.lockTimeoutMs,
    lockStaleMs: config.lockStaleMs,
    env: createEnvSource({ file: config.envFile, logger: ctx.logger }),
  })
  for (const tool of createTools({ vault, config, logger: ctx.logger })) {
    ctx.effect(() => ctx.tools.register(tool))
  }
  if (config.redactToolOutput && typeof ctx.on === 'function') {
    try {
      ctx.on('tools/post-execute', createOutputRedactor(vault, config, ctx.logger))
    } catch {
      ctx.logger?.warn?.('dsh-secrets: tools/post-execute is not available; global output redaction is off')
    }
  }
  mountBridge(ctx, vault)
  ctx.logger?.info?.(`dsh-secrets: vault ${config.vaultPath} (keySource ${config.keySource}`
    + (config.keySource === 'passphrase-env' ? `, passphrase from $${config.passphraseEnv} or ${config.envFile ?? '(no env file)'}` : `, keyfile ${config.keyfilePath}`)
    + '), 10 tools registered')
}

/**
 * Mount the read-only dashboard routes on `ctx.webServer` (optional service,
 * same seam and login wrapper as dsh-token-stats). Without `ctx.inject` or a
 * `webServer.register`, the tools keep working and only the page has no data.
 * @param {any} ctx
 * @param {Vault} vault
 */
function mountBridge(ctx, vault) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('dsh-secrets: webServer exposes no register(); the dashboard bridge is not mounted')
      return
    }
    // Login is checked here: a plugin route outranks the connection's own `/api` check.
    const connection = () => (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
    for (const route of createRoutes({ vault, logger: ctx.logger })) {
      const guarded = requireLogin(route, connection)
      webCtx.effect(() => webServer.register(guarded), `dsh-secrets: ${route.path}`)
    }
    ctx.logger?.info?.(`dsh-secrets: read-only dashboard bridge mounted at ${BRIDGE_BASE}/{summary,list}`)
  })
}
