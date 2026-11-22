#!/usr/bin/env node
/**
 * Build `lib/client.js`: the browser half in the Web shell's module-loader
 * envelope (`window.__ModuleLoader__.load({ id, factory })`), byte-for-byte the
 * shape dsh-client-ui-token-stats / dsh-client-ui-vpn use.
 *
 * esbuild is located, in order, through:
 *   1. `DSH_CLIENT_MODULES` (a node_modules directory that contains esbuild);
 *   2. this package's own `node_modules`;
 *   3. sibling bundles of this repo that already build a client
 *      (dsh-vpn/packages/client-ui-vpn, dsh-router-b/packages/client-ui-router,
 *      dsh-token-stats/packages/client-ui-token-stats).
 * React is never bundled: the shell's module table supplies it.
 *
 * After the build it asserts the envelope, that no `@deepseek-ai/*` package is
 * required at runtime, and that the panel registers its `main` key.
 *
 * Usage (from the bundle root or this package):
 *   node packages/client-ui-agent-hub/scripts/build-client.mjs
 *   DSH_CLIENT_MODULES=/path/to/node_modules node packages/client-ui-agent-hub/scripts/build-client.mjs
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = dirname(dirname(root))
const plugins = dirname(bundle)
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const outFile = join(root, 'lib', 'client.js')

/** Find esbuild without a package manager. */
async function loadEsbuild() {
  const dirs = [
    process.env['DSH_CLIENT_MODULES'] ?? '',
    join(root, 'node_modules'),
    join(plugins, 'dsh-vpn', 'packages', 'client-ui-vpn', 'node_modules'),
    join(plugins, 'dsh-router-b', 'packages', 'client-ui-router', 'node_modules'),
    join(plugins, 'dsh-token-stats', 'packages', 'client-ui-token-stats', 'node_modules'),
  ].filter(dir => dir !== '' && existsSync(join(dir, 'esbuild')))
  for (const dir of dirs) {
    try {
      const require = createRequire(pathToFileURL(join(dir, 'noop.js')))
      const resolved = require.resolve('esbuild')
      console.log(`esbuild: ${resolved}`)
      const mod = await import(pathToFileURL(resolved).href)
      return mod.build ?? mod.default?.build
    } catch (error) {
      console.warn(`esbuild in ${dir} could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  console.error('esbuild was not found. Set DSH_CLIENT_MODULES to a node_modules directory that has esbuild.')
  process.exit(2)
}

const build = await loadEsbuild()

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

// Assertions: same checks dsh-token-stats/scripts/build.mjs runs on its bundle.
const expected = `window.__ModuleLoader__.load({id:${JSON.stringify('dsh-client-ui-agent-hub')},factory:require=>{`
if (!envelope.startsWith(expected)) {
  console.error('client bundle is missing the expected module-loader envelope')
  process.exit(1)
}
const runtimeRequires = envelope.match(/require\(["']@deepseek-ai\//g) ?? []
if (runtimeRequires.length > 0) {
  console.error(`client bundle imports ${String(runtimeRequires.length)} @deepseek-ai/* package(s) at runtime; those must be type-only`)
  process.exit(1)
}
if (!envelope.includes('agent-hub/page') || !envelope.includes('sidebar.panellist')) {
  console.error('client bundle does not register the agent-hub/page main panel and its sidebar row')
  process.exit(1)
}

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, envelope, 'utf8')
console.log(`built ${outFile} (${envelope.length} bytes, envelope + no runtime @deepseek-ai imports)`)
