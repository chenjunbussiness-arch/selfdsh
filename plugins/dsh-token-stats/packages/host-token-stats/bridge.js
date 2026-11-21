/**
 * Same-origin HTTP bridge for the sidebar token panel.
 *
 *   GET /api/token-stats/summary[?force=1]   aggregated usage document
 *
 * Read-only by construction: one GET route, no request body is read, no file is
 * ever written. `force=1` only re-stats the session tree; it is still a read.
 * The route is registered on `ctx.webServer`, the same seam the egress and VPN
 * bundles use, and lives behind the Harness web-server authentication.
 *
 * @module host-token-stats/bridge
 */

/** Path prefix this bundle owns. */
export const BRIDGE_BASE = '/api/token-stats'

/** The one document path. */
export const SUMMARY_PATH = `${BRIDGE_BASE}/summary`

/** Write one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

/**
 * Build the routes to mount.
 * @param {{ store: import('./scanner.js').UsageStore, logger?: object }} deps - the store to read.
 * @returns {ReadonlyArray<{ kind: 'exact', path: string, handler: Function }>} routes to register.
 */
export function createRoutes(deps) {
  const { store, logger } = deps
  return [
    {
      kind: 'exact',
      path: SUMMARY_PATH,
      async handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { code: 'method-not-allowed', message: 'use GET' } }))
          return
        }
        try {
          const url = new URL(req.url ?? SUMMARY_PATH, 'http://localhost')
          const force = url.searchParams.get('force') === '1'
          sendJson(res, 200, await store.document(force ? { force: true } : {}))
        } catch (error) {
          logger?.warn(`token-stats: summary failed: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, 500, { error: { code: 'aggregation-failed', message: error instanceof Error ? error.message : String(error) } })
        }
      },
    },
  ]
}
