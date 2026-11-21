/**
 * Bundle the preview page.
 *
 * Same sources as the plugin bundle, but compiled for a plain static page:
 * CSS files are copied next to the bundle, and React is inlined so the page
 * needs no import map.
 */

import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'preview', 'dist')

await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'preview', 'main.tsx')],
  outfile: join(outDir, 'bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: false,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

for (const file of ['index.html', 'tokens.css']) {
  await copyFile(join(root, 'preview', file), join(outDir, file))
}

console.log(`preview built: ${outDir}`)
