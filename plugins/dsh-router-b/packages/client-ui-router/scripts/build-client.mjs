/**
 * Build `lib/client.js` — the browser half in the Web shell's module-loader
 * envelope.
 *
 * The envelope is not negotiable: the shell fetches this file and evaluates it,
 * and it must call `window.__ModuleLoader__.load({ id, factory })`. `factory`
 * receives the loader's `require` (module-table entries: `react`,
 * `react/jsx-runtime`, `@deepseek-ai/...`) and returns the module exports. The
 * shape below is copied byte-for-byte from a shipped bundle
 * (`dsh-client-ui-agent-team/lib/client.js`) so the loader treats this file
 * exactly like a first-party one.
 */

import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Scripts live one level below the package root; resolve from the file itself.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outFile = join(root, 'lib', 'client.js')

/**
 * Everything the loader, not the bundle, must supply. A value import of one of
 * these stays a `require(...)` call inside the factory.
 */
const externals = [
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom/client',
  'react-dom/server',
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

const body = result.outputFiles[0].text

// `id` must equal the package name: the loader keys entries by it and the
// Modules service reports dependencies against it.
const envelope = `window.__ModuleLoader__.load({id:${JSON.stringify(pkg.name)},factory:require=>{`
  + 'var module={exports:{}};var exports=module.exports;'
  + 'Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});\n'
  + body
  + '\nreturn module.exports}});\n'

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, envelope, 'utf8')
console.log(`built ${outFile} (${envelope.length} bytes)`)
