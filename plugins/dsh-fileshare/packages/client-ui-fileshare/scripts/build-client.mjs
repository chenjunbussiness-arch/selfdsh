/**
 * Build `lib/client.js`: the browser half in the Web shell's module-loader
 * envelope (`window.__ModuleLoader__.load({ id, factory })`), byte-for-byte the
 * shape dsh-client-ui-secrets uses.
 *
 * esbuild is located through `DSH_CLIENT_MODULES` (set by the bundle's
 * `scripts/build.mjs`) or a `node_modules` next to this package. React is never
 * bundled: the shell's module table supplies it.
 *
 * Usage (from this package): node scripts/build-client.mjs
 * Usually run through the bundle: node ../../scripts/build.mjs
 */

import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outFile = join(root, 'lib', 'client.js')

/** Resolve esbuild from DSH_CLIENT_MODULES first, then from this package. */
async function loadEsbuild() {
  const dir = process.env['DSH_CLIENT_MODULES']
  if (dir !== undefined && dir !== '') {
    // `<dir>/noop.js` resolves bare specifiers against `<dir>` itself (a node_modules directory).
    return createRequire(join(dir, 'noop.js'))('esbuild')
  }
  return import('esbuild')
}

const { build } = await loadEsbuild()

/** Everything the loader, not the bundle, must supply. */
const externals = [
  'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client', 'react-dom/server',
  ...Object.keys(pkg.dependencies ?? {}),
]

const result = await build({
  entryPoints: [join(root, 'src', 'client', 'index.ts')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: externals,
  legalComments: 'none',
  logLevel: 'warning',
})

const envelope = `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:require=>{`
  + 'var module={exports:{}};var exports=module.exports;'
  + 'Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});\n'
  + result.outputFiles[0].text
  + '\nreturn module.exports}});\n'

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, envelope, 'utf8')
console.log(`built ${outFile} (${envelope.length} bytes)`)
