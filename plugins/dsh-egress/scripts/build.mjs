#!/usr/bin/env node
/**
 * Build and test everything this bundle ships, in one command: `node scripts/build.mjs`.
 *
 * Order: host compile (also the host type-check), client type-check, client
 * declarations, client bundle, client Node entry, then the host tests, which run
 * against the compiled output so a broken build cannot pass them.
 *
 * The toolchain is looked up rather than assumed, like in dsh-router-b: the host
 * half needs TypeScript >= 5.7 (`rewriteRelativeImportExtensions`), the client
 * package pins an older one, so the highest version found is used for the host.
 * Set DSH_TSC to force one.
 *
 * @module dsh-egress/scripts/build
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'packages', 'client-ui-egress')
const HOST = join(ROOT, 'packages', 'host-egress')

const CANDIDATES = [
  process.env['DSH_TSC'] ?? '',
  join(CLIENT, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(dirname(dirname(ROOT)), 'deepseek-harness-latest', 'node_modules', 'typescript', 'bin', 'tsc'),
  join(dirname(dirname(ROOT)), 'dsh-router-b', 'packages', 'client-ui-router', 'node_modules', 'typescript', 'bin', 'tsc'),
].filter(candidate => candidate !== '' && existsSync(candidate))

/** `[major, minor]` of one compiler, `[0, 0]` when unreadable. */
function versionOf(bin) {
  const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
  const match = /Version (\d+)\.(\d+)/.exec(result.stdout ?? '')
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])]
}

/** Run one command inheriting stdio; exit on failure. */
function run(label, command, args, cwd) {
  console.log(`\n$ ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
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
  console.error(`The host half needs TypeScript >= 5.7. Found: ${ranked.map(e => `${e.bin} (${e.version.join('.')})`).join(', ') || 'none'}. Set DSH_TSC.`)
  process.exit(2)
}
const clientTsc = ranked.find(entry => entry.bin.startsWith(CLIENT))?.bin ?? best.bin
console.log(`host tsc:   ${best.bin} (${best.version.join('.')})`)
console.log(`client tsc: ${clientTsc}`)

if (!existsSync(join(CLIENT, 'node_modules', 'esbuild'))) {
  console.error('packages/client-ui-egress has no node_modules (esbuild, react). Run `npm install` there, or link the node_modules of packages/client-ui-router from dsh-router-b.')
  process.exit(2)
}

run('host: tsc (compile + type-check)', process.execPath, [best.bin, '-p', 'tsconfig.json'], HOST)
run('client: tsc --noEmit', process.execPath, [clientTsc, '-p', 'tsconfig.json', '--noEmit'], CLIENT)
run('client: declarations', process.execPath, [clientTsc, '-p', 'tsconfig.build.json'], CLIENT)
run('client: bundle', process.execPath, ['scripts/build-client.mjs'], CLIENT)
run('client: node entry', process.execPath, ['scripts/build-host.mjs'], CLIENT)
run('host: tests', process.execPath, ['--test', 'tests/validate.test.mjs', 'tests/proxy.test.mjs', 'tests/bridge.test.mjs'], HOST)

console.log('\nbuild ok')
