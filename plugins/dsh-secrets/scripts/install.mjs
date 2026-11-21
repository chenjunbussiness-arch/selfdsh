#!/usr/bin/env node
/**
 * Install or re-install this bundle into one DSH profile.
 *
 * Same approach as the dsh-vpn / dsh-egress installers, idempotent:
 *
 *   1. points the profile's `package.json` at this bundle and its host sub-package
 *      with `link:`;
 *   2. registers the bundle in `dsh.profile.bundles` (sub-packages are libraries,
 *      not bundles);
 *   3. creates the two `node_modules` entries as directory links.
 *
 * It never runs a package manager (a profile-level `pnpm install` rewrites the
 * whole tree), never touches any other bundle, and `--dry-run` writes nothing.
 * It does not restart anything: that is the operator's call.
 *
 * Usage:
 *   node scripts/install.mjs --profile /root/.dsh/profiles/web [--dry-run]
 *   node scripts/install.mjs --profile /root/.dsh/profiles/web --uninstall
 *
 * @module dsh-secrets/scripts/install
 */

import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE = dirname(dirname(fileURLToPath(import.meta.url)))
const NAME = 'dsh-secrets'
const SUBS = ['dsh-host-secrets']

const argv = process.argv.slice(2)
let profileArg
let dryRun = false
let uninstall = false
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--profile') profileArg = argv[++i]
  else if (arg === '--dry-run') dryRun = true
  else if (arg === '--uninstall') uninstall = true
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: node scripts/install.mjs --profile <dir> [--dry-run] [--uninstall]')
    process.exit(0)
  } else {
    console.error(`unknown argument: ${arg}`)
    process.exit(2)
  }
}
if (profileArg === undefined) {
  console.error('usage: node scripts/install.mjs --profile <dir> [--dry-run] [--uninstall]')
  process.exit(2)
}
const profile = resolve(profileArg.replace(/^~(?=$|[\\/])/, homedir()))
const actions = []
const act = (label, apply) => { actions.push(label); if (!dryRun) apply() }

const profileJsonPath = join(profile, 'package.json')
if (!existsSync(profileJsonPath)) {
  console.error(`not a DSH profile (no package.json): ${profile}`)
  process.exit(2)
}

/** Atomic replace that keeps a timestamped copy of the previous bytes. */
function replaceFile(path, text) {
  const previous = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (previous === text) return
  if (previous !== '') writeFileSync(`${path}.bak-install-${Date.now()}`, previous, 'utf8')
  const temp = `${path}.tmp-${Date.now()}`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, path)
}

const original = readFileSync(profileJsonPath, 'utf8')
const pkg = JSON.parse(original)
pkg.dependencies = pkg.dependencies ?? {}
const bundles = pkg.dsh?.profile?.bundles
if (!Array.isArray(bundles)) {
  console.error('profile package.json has no dsh.profile.bundles array; refusing to guess')
  process.exit(2)
}
const wanted = {
  [NAME]: `link:${BUNDLE.replace(/\\/g, '/')}`,
  'dsh-host-secrets': `link:${join(BUNDLE, 'packages', 'host-secrets').replace(/\\/g, '/')}`,
}

if (uninstall) {
  for (const name of [NAME, ...SUBS]) delete pkg.dependencies[name]
  for (const name of [NAME, ...SUBS]) {
    const at = bundles.indexOf(name)
    if (at >= 0) bundles.splice(at, 1)
  }
} else {
  for (const name of SUBS) {
    const at = bundles.indexOf(name)
    if (at >= 0) bundles.splice(at, 1)
  }
  if (!bundles.includes(NAME)) bundles.push(NAME)
  for (const [name, spec] of Object.entries(wanted)) pkg.dependencies[name] = spec
}
if (JSON.stringify(JSON.parse(original)) !== JSON.stringify(pkg)) {
  act(uninstall ? 'package.json: remove dsh-secrets entries' : 'package.json: dependencies + bundles', () => { replaceFile(profileJsonPath, `${JSON.stringify(pkg, undefined, 2)}\n`) })
}

const modules = join(profile, 'node_modules')
for (const [name, spec] of Object.entries(wanted)) {
  const target = spec.slice('link:'.length)
  const linkPath = join(modules, name)
  let existing
  try { existing = lstatSync(linkPath) } catch { existing = undefined }
  if (uninstall) {
    if (existing?.isSymbolicLink()) act(`node_modules: unlink ${name}`, () => { unlinkSync(linkPath) })
    continue
  }
  let pointsHere = false
  if (existing !== undefined) {
    try { pointsHere = realpathSync.native(linkPath).toLowerCase() === realpathSync.native(target).toLowerCase() } catch { pointsHere = false }
  }
  if (pointsHere) continue
  act(`node_modules: ${existing === undefined ? 'link' : 'replace'} ${name}`, () => {
    if (existing !== undefined) {
      if (existing.isSymbolicLink()) unlinkSync(linkPath)
      else rmSync(linkPath, { recursive: true, force: true })
    }
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  })
}

if (actions.length === 0) console.log(`${uninstall ? 'already uninstalled' : 'already installed'}: ${profile}`)
else {
  console.log(`${dryRun ? 'would change' : 'changed'} ${actions.length} thing(s) in ${profile}:`)
  for (const line of actions) console.log(`  - ${line}`)
  if (dryRun) console.log('(dry run: nothing written)')
}
if (!uninstall) {
  console.log('\nNext: restart the service that owns this profile (the operator decides when), then check the log for\n  "dsh-secrets: vault <path> (keySource ...), 10 tools registered". Set DSH_SECRETS_PASSPHRASE in the service environment first.')
}
