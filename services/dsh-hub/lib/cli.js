/**
 * dsh-hub CLI (runs only on the hub machine; never over HTTP):
 *
 *   node server.mjs controller add <id>      mint a controller token (printed ONCE)
 *   node server.mjs controller list
 *   node server.mjs controller revoke <id>
 *
 * It only touches <state dir>/controllers.json, never state.json, so it is
 * safe while the service runs: the service re-reads controllers.json on every
 * controller request.
 *
 * @module dsh-hub/cli
 */

import { homedir } from 'node:os'

import { stateDir } from './config.js'
import { AgentHub, HubError } from './hub.js'

export const USAGE = [
  'usage:',
  '  node server.mjs                          start the hub',
  '  node server.mjs controller add <id>      issue a controller token (shown once)',
  '  node server.mjs controller list          list controllers',
  '  node server.mjs controller revoke <id>   revoke a controller token',
].join('\n')

/**
 * @param {string[]} argv arguments after `server.mjs`
 * @returns {Promise<number>} exit code
 */
export async function runCli(argv, { env = {}, home = homedir(), out = console.log, err = console.error, clock } = {}) {
  const [group, action, id, ...rest] = argv
  if (group === 'help' || group === '--help' || group === '-h') { out(USAGE); return 0 }
  if (group !== 'controller' || rest.length > 0) { err(USAGE); return 2 }
  const hub = new AgentHub({ dataDir: stateDir(env, home), clock })
  try {
    if (action === 'add' && id !== undefined) {
      const { controller, token } = await hub.addController(id)
      out(`controller ${controller.controller_id} added (${controller.created_at}).`)
      out('Token - shown only this once; store it now on the controller as DSH_HUB_TOKEN (process env or <DSH home>/agent-hub/controller.env, chmod 600; NEVER <DSH home>/.env - DSH refuses to start on DSH_* lines there):')
      out(token)
      return 0
    }
    if (action === 'list' && id === undefined) {
      const list = await hub.listControllers()
      if (list.length === 0) { out('no controllers (add one: node server.mjs controller add <id>)'); return 0 }
      for (const c of list) out(`${c.controller_id}\t${c.revoked ? 'revoked' : 'active'}\tcreated ${c.created_at}${c.revoked_at ? `\trevoked ${c.revoked_at}` : ''}`)
      return 0
    }
    if (action === 'revoke' && id !== undefined) {
      const c = await hub.revokeController(id)
      out(`controller ${c.controller_id} revoked (${c.revoked_at}); its token no longer works.`)
      return 0
    }
    err(USAGE)
    return 2
  } catch (error) {
    if (error instanceof HubError) { err(`error: ${error.message}`); return 1 }
    throw error
  }
}
