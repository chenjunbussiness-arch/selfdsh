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

/**
 * Wrap a route so it answers only a logged-in browser.
 *
 * `dsh-client-connection` checks the login cookie on its `/api` prefix route,
 * but `/api/token-stats/summary` is a longer match, so the web server picks it
 * first and that check never runs. This puts the same check back.
 *
 * @param {{ kind: string, path: string, handler: Function }} route - the bridge route.
 * @param {() => ({ requestRejection?: (req: import('node:http').IncomingMessage) => number | undefined } | undefined)} connection - reads the `connection` service at request time.
 * @returns {{ kind: string, path: string, handler: Function }} the guarded route (401/403 from the connection, 503 when it is not up).
 */
export function requireLogin(route, connection) {
  return {
    ...route,
    handler: async (req, res) => {
      const check = connection()
      const rejection = typeof check?.requestRejection === 'function' ? check.requestRejection(req) : 503
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : 'login service unavailable')
        return
      }
      await route.handler(req, res)
    },
  }
}
