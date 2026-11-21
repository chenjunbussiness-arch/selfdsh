/**
 * Build `lib/index.js` — the Node half, plain ESM.
 *
 * Harness packages stay imports (the profile's own dependency tree provides
 * them); this file has no imports at all today, but the rule is stated so a
 * later Host-side addition does not accidentally inline a framework copy.
 */

import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Scripts live one level below the package root; resolve from the file itself.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outFile = join(root, 'lib', 'index.js')

const result = await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  bundle: false,
  write: false,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: outFile,
  logLevel: 'warning',
})

await mkdir(dirname(outFile), { recursive: true })
const { writeFile } = await import('node:fs/promises')
await writeFile(outFile, result.outputFiles[0].text, 'utf8')
console.log(`built ${outFile}`)
