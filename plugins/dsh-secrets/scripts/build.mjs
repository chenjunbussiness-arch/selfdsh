#!/usr/bin/env node
/**
 * Build every artifact this bundle ships.
 *
 * The host half is plain ESM JavaScript (no compile step), so this script
 * 1. syntax-checks the host modules with `node --check`;
 * 2. finds an esbuild installation (DSH_CLIENT_MODULES, a sibling bundle's
 *    client package, or the dashboard package's own node_modules) and links it
 *    next to the client package;
 * 3. runs the dashboard bundle build and asserts the module-loader envelope,
 *    that no `@deepseek-ai/*` package is required at runtime, and that the
 *    page registers its `main` panel and Sidebar row.
 *
 * Usage: node scripts/build.mjs
 *
 * @module dsh-secrets/scripts/build
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'packages', 'client-ui-secrets')
const HOST = join(ROOT, 'packages', 'host-secrets')
const PROJECTS = dirname(ROOT)

/** Run one command, inheriting stdio, and exit on failure. */
function run(label, command, args, cwd, env = {}) {
  console.log(`\n$ ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${String(result.status)})`)
    process.exit(result.status ?? 1)
  }
}

// 1. Host half: no compiler, just a syntax check.
for (const file of ['index.js', 'config.js', 'vault.js', 'redact.js', 'placeholders.js', 'tools.js', 'bridge.js']) {
  run(`node --check ${file}`, process.execPath, ['--check', join(HOST, file)], HOST)
}

// 2. esbuild lives in another package's node_modules; link it next to the client package.
const MODULE_DIRS = [
  process.env['DSH_CLIENT_MODULES'] ?? '',
  join(CLIENT, 'node_modules'),
  join(PROJECTS, 'dsh-token-stats', 'packages', 'client-ui-token-stats', 'node_modules'),
  join(PROJECTS, 'dsh-vpn', 'packages', 'client-ui-vpn', 'node_modules'),
  join(PROJECTS, 'dsh-router-b', 'packages', 'client-ui-router', 'node_modules'),
].filter(dir => dir !== '' && existsSync(join(dir, 'esbuild')))
const modules = MODULE_DIRS[0]
if (modules === undefined) {
  console.error('esbuild was not found. Set DSH_CLIENT_MODULES to a node_modules directory that has esbuild.')
  process.exit(2)
}
console.log(`client modules: ${modules}`)
const own = join(CLIENT, 'node_modules')
if (!existsSync(own)) {
  symlinkSync(modules, own, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`linked ${own} -> ${modules}`)
}

// 3. Client half: one esbuild pass in the module-loader envelope.
run('client bundle', process.execPath, ['scripts/build-client.mjs'], CLIENT, { DSH_CLIENT_MODULES: modules })

// 4. Assert the artifact: envelope id, no runtime @deepseek-ai require, both registrations.
const clientBundle = readFileSync(join(CLIENT, 'lib', 'client.js'), 'utf8')
const envelope = 'window.__ModuleLoader__.load({id:"dsh-client-ui-secrets",factory:require=>{'
if (!clientBundle.startsWith(envelope)) {
  console.error('client bundle is missing the expected module-loader envelope')
  process.exit(1)
}
const runtimeRequires = clientBundle.match(/require\(["']@deepseek-ai\//g) ?? []
if (runtimeRequires.length > 0) {
  console.error(`client bundle imports ${String(runtimeRequires.length)} @deepseek-ai/* package(s) at runtime; those must be type-only or external`)
  process.exit(1)
}
for (const needle of ['secrets/page', 'sidebar.panellist', '/api/secrets']) {
  if (!clientBundle.includes(needle)) {
    console.error(`client bundle does not contain ${JSON.stringify(needle)}`)
    process.exit(1)
  }
}
console.log(`ok: ${join(CLIENT, 'lib', 'client.js')} (${String(clientBundle.length)} bytes, envelope + no runtime @deepseek-ai imports)`)
