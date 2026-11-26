#!/usr/bin/env node
/**
 * dsh-hub: standalone hub for DSH controllers and agent workers
 * (protocol dsh-agent/2.0, docs/DSH-HUB-PROTOCOL-v2.md).
 *
 *   node server.mjs                          start (config: <DSH home>/agent-hub/hub.json)
 *   node server.mjs controller add <id>      issue a controller token (shown once)
 *   node server.mjs controller list | revoke <id>
 *
 * Node >= 22, no third-party dependencies. Exit code 78 = configuration error
 * (the systemd unit does not restart on it).
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'

import { runCli } from './lib/cli.js'
import { checkTlsKey, ConfigError, loadConfig } from './lib/config.js'
import { createHubServer } from './lib/http.js'
import { AgentHub, PROTOCOL, VERSION } from './lib/hub.js'

const EX_CONFIG = 78

function makeLogger() {
  const line = (level, args) => `${new Date().toISOString()} ${level} ${args.map(String).join(' ')}`
  return {
    info: (...args) => console.log(line('info', args)),
    warn: (...args) => console.warn(line('warn', args)),
    error: (...args) => console.error(line('error', args)),
  }
}

async function start() {
  const logger = makeLogger()
  let loaded
  try {
    loaded = await loadConfig({ env: process.env, home: homedir() })
  } catch (error) {
    logger.error(`dsh-hub: ${error.message}`)
    return EX_CONFIG
  }
  const { config, warnings, dir, path } = loaded
  for (const w of warnings) logger.warn(`dsh-hub: ${w}`)

  let tlsMaterial
  if (config.tls) {
    try {
      const keyWarning = await checkTlsKey(config.tls.key)
      if (keyWarning) logger.warn(`dsh-hub: ${keyWarning}`)
      tlsMaterial = { cert: await readFile(config.tls.cert), key: await readFile(config.tls.key) }
    } catch (error) {
      logger.error(`dsh-hub: ${error instanceof ConfigError ? error.message : `cannot load TLS material: ${error.message}`}`)
      return EX_CONFIG
    }
  }

  const hub = new AgentHub({ dataDir: dir, maxRetries: config.maxRetries, offlineAfterMs: config.offlineAfterMs, fallback: config.fallback, sticky: config.sticky, expiry: config.expiry, due: config.due, autoApprove: config.autoApprove, logger })
  await hub.load() // fail fast on a corrupt state.json
  const active = (await hub.listControllers()).filter(c => !c.revoked)
  if (active.length === 0) logger.warn('dsh-hub: no active controller yet; run: node server.mjs controller add <id>')

  let server
  let host
  try {
    ({ server, host } = createHubServer({ hub, logger, config, tlsMaterial }))
  } catch (error) {
    logger.error(`dsh-hub: ${error.message}`)
    return EX_CONFIG
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, host, () => { server.off('error', reject); resolve() })
  })
  logger.info(`dsh-hub ${VERSION} (${PROTOCOL}) listening on ${config.tls ? 'https' : 'http'}://${host}:${config.port}; config ${path}; state ${dir}; allow ${config.allow.length ? config.allow.join(', ') : 'any'}`)

  const timer = setInterval(() => {
    hub.sweep().then(
      (n) => { if (n > 0) logger.info(`dsh-hub: sweeper changed ${n} task(s)/request(s)`) },
      error => logger.warn(`dsh-hub: sweep failed: ${error instanceof Error ? error.message : String(error)}`),
    )
  }, config.sweepIntervalMs)

  return new Promise((resolve) => {
    let stopping = false
    const stop = async (signal) => {
      if (stopping) return
      stopping = true
      logger.info(`dsh-hub: ${signal}, shutting down`)
      clearInterval(timer)
      const closed = new Promise(r => server.close(() => r()))
      await hub.close() // long polls return at once
      server.closeIdleConnections?.()
      const force = setTimeout(() => server.closeAllConnections?.(), 5000)
      force.unref?.()
      await closed
      clearTimeout(force)
      resolve(0)
    }
    process.on('SIGTERM', () => { stop('SIGTERM') })
    process.on('SIGINT', () => { stop('SIGINT') })
  })
}

const argv = process.argv.slice(2)
try {
  process.exitCode = argv.length > 0 ? await runCli(argv, { env: process.env, home: homedir() }) : await start()
} catch (error) {
  console.error(`dsh-hub: fatal: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
}
