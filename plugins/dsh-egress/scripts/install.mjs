#!/usr/bin/env node
/**
 * Install or re-install this bundle into one DSH profile.
 *
 * The point of this script is migration: after a DSH upgrade — or on a machine
 * that has never seen this bundle — the same command puts it back. Every step is
 * idempotent, so running it twice is a no-op rather than a second copy.
 *
 * What it does, in order:
 *
 *   1. points the profile's `package.json` at this bundle and at the two
 *      sub-packages, using `link:` so a profile never holds a stale copy;
 *   2. registers the bundle in `dsh.profile.bundles`;
 *   3. creates the three `node_modules` entries as directory links.
 *
 * What it deliberately does NOT do: run a package manager. A profile-level
 * `pnpm install` rewrites the whole tree and has already destroyed a package in
 * place on this deployment; a link plus a `package.json` line is enough for the
 * loader, and it is reversible with a text editor.
 *
 * Usage:
 *
 *   node scripts/install.mjs --profile ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --profile <dir> --dry-run
 *
 * @module dsh-egress/scripts/install
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bundle root, resolved from this file rather than from the cwd. */
const BUNDLE = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Read the parsed arguments.
 * @returns `{ profile, dryRun }`.
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  let profile
  let dryRun = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') { profile = argv[++index]; continue }
    if (arg === '--dry-run') { dryRun = true; continue }
    if (arg === '--help' || arg === '-h') { console.log('usage: node scripts/install.mjs --profile <dir> [--dry-run]'); process.exit(0) }
    console.error(`unknown argument: ${arg}`)
    process.exit(2)
  }
  if (profile === undefined) { console.error('usage: node scripts/install.mjs --profile <dir> [--dry-run]'); process.exit(2) }
  return { profile: resolve(profile.replace(/^~(?=$|[\\/])/, homedir())), dryRun }
}

const { profile, dryRun } = parseArgs()

/** One thing this run did, or would do. */
const actions = []

/**
 * Record one action and optionally perform it.
 * @param label - what changed, in the past tense.
 * @param apply - performs the change; skipped in a dry run.
 */
function act(label, apply) {
  actions.push(label)
  if (!dryRun) apply()
}

const profileJsonPath = join(profile, 'package.json')
if (!existsSync(profileJsonPath)) {
  console.error(`not a DSH profile (no package.json): ${profile}`)
  process.exit(2)
}

/**
 * Write one file atomically, keeping a timestamped copy of the previous bytes.
 * @param path - file to replace.
 * @param text - new contents.
 */
function replaceFile(path, text) {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (previous === text) return false
  if (previous !== '') writeFileSync(`${path}.bak-install-${Date.now()}`, previous, 'utf8')
  const temp = `${path}.tmp-${Date.now()}`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, path)
  return true
}

// --- 1/2. profile package.json ---------------------------------------------

const originalPkgText = readFileSync(profileJsonPath, 'utf8')
const pkg = JSON.parse(originalPkgText)
pkg.dependencies = pkg.dependencies ?? {}
const wanted = {
  'dsh-egress': `link:${BUNDLE.replace(/\\/g, '/')}`,
  'dsh-host-egress': `link:${join(BUNDLE, 'packages', 'host-egress').replace(/\\/g, '/')}`,
  'dsh-client-ui-egress': `link:${join(BUNDLE, 'packages', 'client-ui-egress').replace(/\\/g, '/')}`,
}
const bundles = pkg.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('profile package.json has no dsh.profile.bundles array; refusing to guess')
  process.exit(2)
}
// The sub-packages are libraries the bundle mounts by name, not bundles of their
// own. A loader that finds one in this list activates it standalone, using that
// package's own patch — which is machine-specific and fails on any host whose
// paths differ. Installing must therefore also undo that entry.
for (const name of ['dsh-host-egress', 'dsh-client-ui-egress']) {
  const at = bundles.indexOf(name)
  if (at >= 0) bundles.splice(at, 1)
}
if (!bundles.includes('dsh-egress')) bundles.push('dsh-egress')
for (const [name, spec] of Object.entries(wanted)) pkg.dependencies[name] = spec

const nextPkgText = `${JSON.stringify(pkg, undefined, 2)}\n`
// Compare semantics, not bytes: a profile written with other indentation and key
// order is already correct, and rewriting it would be an unrequested edit to a
// file the user maintains.
const semanticChange = JSON.stringify(JSON.parse(originalPkgText)) !== JSON.stringify(pkg)
if (semanticChange) {
  act('package.json: dependencies + bundles', () => { replaceFile(profileJsonPath, nextPkgText) })
}

// --- 3. node_modules links --------------------------------------------------

const modules = join(profile, 'node_modules')
// A fresh profile (first `dsh web` run, or a new machine) has no node_modules yet.
if (!dryRun) mkdirSync(modules, { recursive: true })
for (const [name, spec] of Object.entries(wanted)) {
  const target = spec.slice('link:'.length)
  const linkPath = join(modules, name)
  let existing
  try {
    existing = lstatSync(linkPath)
  } catch {
    existing = undefined
  }
  // A profile holds links, never copies. Anything at this path that does not
  // resolve to the bundle — including a stale pnpm copy — is replaced.
  //
  // The comparison must use `realpath`, not `resolve`: on Windows a junction's
  // path is a name, and only `realpath` follows it to the target. Comparing
  // lexically made every second run "replace" a link that was already correct.
  let pointsHere = false
  if (existing !== undefined) {
    try {
      const same = realpathSync.native(linkPath).toLowerCase()
      pointsHere = same === realpathSync.native(target).toLowerCase()
    } catch {
      pointsHere = false
    }
  }
  if (pointsHere) continue
  act(`node_modules: ${existing === undefined ? 'link' : 'replace'} ${name}`, () => {
    if (existing !== undefined) {
      // A link is removed as a link; a package manager copy is a real directory
      // and needs a recursive removal. Its files are hard links into the bundle
      // on this deployment, so this drops the copy without touching the source.
      if (existing.isSymbolicLink()) unlinkSync(linkPath)
      else rmSync(linkPath, { recursive: true, force: true })
    }
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  })
}

// --- report -----------------------------------------------------------------

if (actions.length === 0) {
  console.log(`already installed: ${profile}`)
} else {
  console.log(`${dryRun ? 'would change' : 'changed'} ${actions.length} thing(s) in ${profile}:`)
  for (const line of actions) console.log(`  - ${line}`)
  if (dryRun) console.log('(dry run: nothing written)')
}
console.log([
  '',
  'Next: restart the app that owns this profile, then check',
  '  - the log has "dsh-egress: fetch hook installed" and "HTTP bridge mounted at /api/egress"',
  '  - the sidebar has an "Egress" row',
  '  - the panel shows no "Sample data" badge',
].join('\n'))
