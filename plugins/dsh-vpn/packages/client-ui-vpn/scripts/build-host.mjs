/** Build `lib/index.js`: the (empty) Node half, plain ESM, no imports. */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
await writeFile(outFile, result.outputFiles[0].text, 'utf8')
console.log(`built ${outFile}`)
