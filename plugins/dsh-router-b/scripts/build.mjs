#!/usr/bin/env node
/**
 * Build every artifact this bundle ships.
 *
 * The bundle is consumed as files (`lib/*.js`), not as source, so a migration to
 * a new machine or a new DSH version only needs a working build. This script is
 * that build, in one command, with the toolchain looked up rather than assumed:
 * the repo carries no `node_modules` of its own, and hard-coding a compiler path
 * is exactly the kind of thing that breaks the day the checkout moves.
 *
 * Order matters: declarations and types first (they are the only step that can
 * fail for a reason worth reading), then the two browser/host bundles.
 *
 * @module dsh-router-b/scripts/build
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT = join(ROOT, 'packages', 'client-ui-router')
const HOST = join(ROOT, 'packages', 'host-router')

/** Sibling checkout that ships a newer TypeScript, used as a fallback. */
const SIBLING_TS = join(dirname(ROOT), 'deepseek-harness-latest', 'node_modules', 'typescript', 'bin', 'tsc')

/**
 * Every compiler this machine might have, best-guess first.
 *
 * The host half imports with `.ts` specifiers and emits JavaScript, which needs
 * TypeScript 5.7's `rewriteRelativeImportExtensions`; the client package pins an
 * older compiler because it only emits declarations and one bundle. So the two
 * steps cannot share a binary on every machine, and the version is measured
 * rather than assumed.
 */
const CANDIDATES = [
  process.env['DSH_TSC'] ?? '',
  join(CLIENT, 'node_modules', 'typescript', 'bin', 'tsc'),
  join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  SIBLING_TS,
].filter(candidate => candidate !== '' && existsSync(candidate))

/**
 * Read one compiler's `--version`.
 * @param bin - path to a `tsc` entry point.
 * @returns `[major, minor]`, or `[0, 0]` when it cannot be read.
 */
function versionOf(bin) {
  const result = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' })
  const match = /Version (\d+)\.(\d+)/.exec(result.stdout ?? '')
  return match === null ? [0, 0] : [Number(match[1]), Number(match[2])]
}


/**
 * Run one command, inheriting stdio, and exit on failure.
 * @param label - what this step is, for the failure message.
 * @param command - executable.
 * @param args - arguments.
 * @param cwd - working directory.
 */
function run(label, command, args, cwd) {
  console.log(`\n$ ${label}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`\n${label} failed (exit ${String(result.status)})`)
    process.exit(result.status ?? 1)
  }
}

const tsc = CANDIDATES.find(candidate => candidate !== '' && existsSync(candidate))
if (tsc === undefined) {
  console.error([
    'No TypeScript compiler found.',
    'Install it in the client package (`pnpm install` in packages/client-ui-router),',
    'or point DSH_TSC at a tsc entry point.',
  ].join('\n'))
  process.exit(2)
}
console.log(`client tsc: ${tsc}`)

// The host half needs 5.7 or newer; pick the highest version available instead of
// letting a successful-looking build fail halfway through.
const ranked = CANDIDATES
  .map(bin => ({ bin, version: versionOf(bin) }))
  .sort((left, right) => (right.version[0] - left.version[0]) || (right.version[1] - left.version[1]))
const host = ranked[0]
if (host === undefined || host.version[0] < 5 || (host.version[0] === 5 && host.version[1] < 7)) {
  console.error([
    'The host half needs TypeScript >= 5.7 (it emits `.ts`-specifier imports).',
    `Found: ${ranked.map(entry => `${entry.bin} (${entry.version.join('.')})`).join(', ') || 'none'}`,
    'Set DSH_TSC to a 5.7+ tsc entry point.',
  ].join('\n'))
  process.exit(2)
}
console.log(`host tsc:   ${host.bin} (${host.version.join('.')})`)

// 1. Types. `tsconfig.build.json` only emits declarations; the collision this
//    used to hit (TS5056) came from two sources differing only in case.
run('client declarations', process.execPath, [tsc, '-p', 'tsconfig.build.json'], CLIENT)

// 2. Browser half: one esbuild pass through the module-loader envelope.
run('client bundle', process.execPath, ['scripts/build-client.mjs'], CLIENT)

// 3. Host half: plain tsc project build, which also type-checks the sources.
run('host bundle', process.execPath, [host.bin, '-b'], HOST)

// 4. The host project's own tests: they import the compiled output, so a broken
//    build cannot pass them.
run('host tests', process.execPath, ['--test', 'tests/bridge.test.mjs', 'tests/router.test.mjs'], HOST)

console.log('\nbuild ok')
