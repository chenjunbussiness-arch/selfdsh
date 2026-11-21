/** Static server for the preview build. Localhost only, only `preview/dist`. Port 4790 (4788 belongs to the router preview). */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), 'preview', 'dist')
const port = Number(process.env.PORT ?? 4790)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost')
  const relativePath = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  const file = join(root, relativePath === '' ? 'index.html' : relativePath)
  if (!file.startsWith(root)) { response.writeHead(403).end('forbidden'); return }
  try {
    const info = await stat(file)
    if (!info.isFile()) throw new Error('not a file')
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    createReadStream(file).pipe(response)
  } catch {
    response.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${port}/  (?state=connected|connecting|failed|disconnected  &edit=password|token-url|<id>  &theme=dark  &lang=en)`)
})
