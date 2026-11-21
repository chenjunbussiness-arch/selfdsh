#!/usr/bin/env node
/**
 * Build every artifact this bundle ships, then run the host tests.
 *
 * Same toolchain lookup as dsh-router-b's build: the repo carries no compiler of
 * its own, so one is found (DSH_TSC, then a sibling `deepseek-harness-latest`,
 * then the router's client package). The host half needs TypeScript >= 5.7
 * (`rewriteRelativeImportExtensions`); the highest version found is used. The
 * client half needs esbuild and React types, which live in a package's
 * `node_modules`; one is looked up the same way (`DSH_CLIENT_MODULES`, the
 * client package's own, or dsh-router-b's).
 *
 * @module dsh-vpn/scripts/build
 */

import { spawnSync } from 'node:child_process'
import { existsSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'packages', 'client-ui-vpn')
const HOST = join(ROOT, 'packages', 'host-vpn')
const NETOPS = dirname(ROOT)
const PROJECTS = dirname(NETOPS)

const CANDIDATES = [
  process.env['DSH_TSC'] ?? '',
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(PROJECTS, 'deepseek-harness-latest', 'node_modules', 'typescript', 'bin', 'tsc'),
  join(PROJECTS, 'dsh-router-b', 'packages', 'client-ui-router', 'node_modules', 'typescript', 'bin', 'tsc'),
].filter(candidate => candidate !== '' && existsSync(candidate))

/** `[major, minor]` of one compiler, or `[0, 0]`. */
function versionOf(bin) {
  const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
  const match = /Version (\d+)\.(\d+)/.exec(result.stdout ?? '')
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])]
}

/** Run one command, inheriting stdio, and exit on failure. */
function run(label, command, args, cwd, env = {}) {
  console.log(`\n$ ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${String(result.status)})`)
    process.exit(result.status ?? 1)
  }
}

const ranked = CANDIDATES
  .map(bin => ({ bin, version: versionOf(bin) }))
  .sort((left, right) => (right.version[0] - left.version[0]) || (right.version[1] - left.version[1]))
const best = ranked[0]
if (best === undefined || best.version[0] < 5 || (best.version[0] === 5 && best.version[1] < 7)) {
  console.error(`TypeScript >= 5.7 is required. Found: ${ranked.map(entry => `${entry.bin} (${entry.version.join('.')})`).join(', ') || 'none'}\nSet DSH_TSC to a tsc entry point.`)
  process.exit(2)
}
console.log(`tsc: ${best.bin} (${best.version.join('.')})`)

const MODULE_DIRS = [
  process.env['DSH_CLIENT_MODULES'] ?? '',
  join(CLIENT, 'node_modules'),
  join(PROJECTS, 'dsh-router-b', 'packages', 'client-ui-router', 'node_modules'),
].filter(dir => dir !== '' && existsSync(join(dir, 'esbuild')))
const modules = MODULE_DIRS[0]
if (modules === undefined) {
  console.error('esbuild and react were not found. Run `npm install` in packages/client-ui-vpn, or set DSH_CLIENT_MODULES to a node_modules directory that has them.')
  process.exit(2)
}
console.log(`client modules: ${modules}`)
const env = { DSH_CLIENT_MODULES: modules }
// tsc and esbuild resolve `react` / `@types/react` from the importing file's own tree, so the client
// package needs a `node_modules` next to it. `npm install` makes a real one; without it a directory
// link to the discovered one is made (git-ignored, removable with `rmdir`, never recursively deleted).
const own = join(CLIENT, 'node_modules')
if (!existsSync(own)) {
  symlinkSync(modules, own, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`linked ${own} -> ${modules}`)
}

// 1. Host half: tsc project build (type-checks and emits lib/*.js with .js specifiers).
run('host bundle (tsc -b)', process.execPath, [best.bin, '-b'], HOST)
// 2. Client half: type-check, then one esbuild pass in the module-loader envelope.
run('client typecheck', process.execPath, [best.bin, '-p', 'tsconfig.json', '--noEmit'], CLIENT)
run('client bundle', process.execPath, ['scripts/build-client.mjs'], CLIENT, env)
run('client host half', process.execPath, ['scripts/build-host.mjs'], CLIENT, env)
// 3. Host tests import the compiled output, so a broken build cannot pass them.
run('host tests', process.execPath, ['--test', 'tests/vpn.test.mjs'], HOST)

console.log('\nbuild ok')
