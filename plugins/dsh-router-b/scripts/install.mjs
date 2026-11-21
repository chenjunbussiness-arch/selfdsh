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
 *   3. creates the three `node_modules` entries as directory links;
 *   4. optionally disables the official brand plugin so this bundle's mark and
 *      name can take those two `single` slots.
 *
 * What it deliberately does NOT do: run a package manager. A profile-level
 * `pnpm install` rewrites the whole tree and has already destroyed a package in
 * place on this deployment; a link plus a `package.json` line is enough for the
 * loader, and it is reversible with a text editor.
 *
 * Usage:
 *
 *   node scripts/install.mjs --profile ~/.dsh/profiles/desktop
 *   node scripts/install.mjs --profile <dir> --disable-brand
 *   node scripts/install.mjs --profile <dir> --dry-run
 *
 * @module dsh-router-b/scripts/install
 */

import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bundle root, resolved from this file rather than from the cwd. */
const BUNDLE = dirname(dirname(fileURLToPath(import.meta.url)))

/** The row id of the official brand plugin inside the web-app bundle. */
const BRAND_ROW = 'ui-brand-official'

/**
 * Read the parsed arguments.
 * @returns `{ profile, dryRun, disableBrand }`.
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  let profile
  let dryRun = false
  let disableBrand = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') {
      profile = argv[++index]
      continue
    }
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--disable-brand') {
      disableBrand = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/install.mjs --profile <dir> [--disable-brand] [--dry-run]')
      process.exit(0)
    }
    console.error(`unknown argument: ${arg}`)
    process.exit(2)
  }
  if (profile === undefined) {
    console.error('usage: node scripts/install.mjs --profile <dir> [--disable-brand] [--dry-run]')
    process.exit(2)
  }
  return { profile: resolve(profile.replace(/^~(?=$|[\\/])/, homedir())), dryRun, disableBrand }
}

const { profile, dryRun, disableBrand } = parseArgs()

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
  'dsh-router-b': `link:${BUNDLE.replace(/\\/g, '/')}`,
  'dsh-host-router': `link:${join(BUNDLE, 'packages', 'host-router').replace(/\\/g, '/')}`,
  'dsh-client-ui-router': `link:${join(BUNDLE, 'packages', 'client-ui-router').replace(/\\/g, '/')}`,
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
for (const name of ['dsh-host-router', 'dsh-client-ui-router']) {
  const at = bundles.indexOf(name)
  if (at >= 0) bundles.splice(at, 1)
}
if (!bundles.includes('dsh-router-b')) bundles.push('dsh-router-b')
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

// --- 4. brand row -----------------------------------------------------------

if (disableBrand) {
  const patchPath = join(profile, 'cordis.patch.yml')
  const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const already = new RegExp(`^- id: ${BRAND_ROW}\\s*$[\\s\\S]{0,200}?disabled: true`, 'm').test(patch)
  if (!already) {
    const block = [
      '',
      '# 换品牌：sidebar.brand.mark / sidebar.brand.name 是 single 座位，被官方 plugin',
      '# 占着时再注册会抛错，所以必须先停用官方行，dsh-client-ui-router 才能接管。',
      `- id: ${BRAND_ROW}`,
      '  name: "@deepseek-ai/dsh-client-ui-brand-official"',
      '  disabled: true',
      '',
    ].join('\n')
    act('cordis.patch.yml: disable ui-brand-official', () => {
      replaceFile(patchPath, `${patch}${patch === '' || patch.endsWith('\n') ? '' : '\n'}${block}`)
    })
  }
}

// --- 5. partition roots -----------------------------------------------------

// The bundle's patch names absolute roots, and a root is a property of the
// machine, not of the plugin. A missing one does not fail the install — the
// router would simply route into a directory that is not there — so it is
// reported loudly instead of silently.
const rootsPatch = join(BUNDLE, 'cordis.patch.yml')
const missingRoots = existsSync(rootsPatch)
  ? [...readFileSync(rootsPatch, 'utf8').matchAll(/^\s*root:\s*(\S+)\s*$/gm)]
      .map(match => match[1])
      .filter(root => !existsSync(root))
  : []

// --- report -----------------------------------------------------------------

if (actions.length === 0) {
  console.log(`already installed: ${profile}`)
} else {
  console.log(`${dryRun ? 'would change' : 'changed'} ${actions.length} thing(s) in ${profile}:`)
  for (const line of actions) console.log(`  - ${line}`)
  if (dryRun) console.log('(dry run: nothing written)')
}
if (missingRoots.length > 0) {
  console.warn([
    '',
    'warning: these partition roots from cordis.patch.yml do not exist on this machine:',
    ...missingRoots.map(root => `  - ${root}`),
    'Edit them for this deployment, or override the host-router row in the profile patch.',
  ].join('\n'))
}
console.log([
  '',
  'Next: restart the app that owns this profile, then check',
  '  - `<DSH home>/router/seams.json` (ok: true, and no required seam is false)',
  '  - the conversation header shows a "Routing" button',
  '  - the panel lists real partitions, not sample data',
].join('\n'))
