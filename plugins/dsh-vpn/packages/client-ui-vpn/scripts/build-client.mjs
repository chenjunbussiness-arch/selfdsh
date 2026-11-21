/**
 * Build `lib/client.js`: the browser half in the Web shell's module-loader
 * envelope (`window.__ModuleLoader__.load({ id, factory })`), byte-for-byte the
 * shape dsh-client-ui-router uses.
 */

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outFile = join(root, 'lib', 'client.js')

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
