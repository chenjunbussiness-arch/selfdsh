/**
 * MCP gateway of dsh-hub, for agents that can only be MCP CLIENTS (AWS Quick).
 *
 *   POST /oauth/token  client_credentials: client_id = agent id, client_secret =
 *                      its worker token (form or JSON body, or HTTP Basic).
 *                      Answers a 15 minute bearer token; the worker token
 *                      itself never travels with each call.
 *   POST /mcp          MCP over Streamable HTTP, JSON responses (no SSE needed:
 *                      every tool answers at once, well inside Quick's 5 min).
 *
 * Five tools, all scoped to the calling agent exactly like the /v1 worker
 * routes: next_task, get_input, report_progress, submit_result, release_task.
 * A revoked agent's bearer tokens stop working at once (every call re-checks
 * the agent in the hub).
 *
 * @module dsh-hub/mcp
 */

import { randomBytes } from 'node:crypto'

import { AGENT_ID_RE, HubError } from './hub.js'

export const MCP_PATH = '/mcp'
export const TOKEN_PATH = '/oauth/token'
export const BEARER_TTL_MS = 15 * 60_000
export const MAX_BEARERS = 1000
export const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const SERVER_INFO = { name: 'dsh-hub', version: '3.0' }

const INSTRUCTIONS = 'Call next_task. If it returns a task, do it, then call submit_result with the same task_id. '
  + 'Use get_input for its input files, report_progress for long work, release_task if you cannot do it.'

const id = { type: 'string', description: 'task_id from next_task' }

/** Short descriptions on purpose: every word is sent on each tools/list. */
export const TOOLS = [
  {
    name: 'next_task',
    description: 'Take the next task meant for you. Returns {task: null} when there is none.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_input',
    description: 'Read an input file of your task (text, or base64 for binary).',
    inputSchema: {
      type: 'object', required: ['task_id', 'name'], additionalProperties: false,
      properties: { task_id: id, name: { type: 'string' }, from_task: { type: 'string', description: 'set for an upstream output' } },
    },
  },
  {
    name: 'report_progress',
    description: 'Report progress on your task; also keeps it yours. Its reply may carry answers to your earlier questions.',
    inputSchema: {
      type: 'object', required: ['task_id'], additionalProperties: false,
      properties: { task_id: id, progress: { type: 'number', minimum: 0, maximum: 1 }, message: { type: 'string' } },
    },
  },
  {
    name: 'submit_result',
    description: 'Finish your task. status completed, failed or partial (asks a human: needs_input; the task comes back to you with the answer in answers); files are optional.',
    inputSchema: {
      type: 'object', required: ['task_id', 'status', 'summary'], additionalProperties: false,
      properties: {
        task_id: id,
        status: { type: 'string', enum: ['completed', 'failed', 'partial'] },
        summary: { type: 'string' },
        files: {
          type: 'array', maxItems: 50,
          items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, text: { type: 'string' }, base64: { type: 'string' } } },
        },
        needs_input: { type: 'string', description: 'for partial: what a human must answer' },
      },
    },
  },
  {
    name: 'release_task',
    description: 'Give your task back when you cannot do it; it goes to someone else.',
    inputSchema: {
      type: 'object', required: ['task_id'], additionalProperties: false,
      properties: { task_id: id, reason: { type: 'string' } },
    },
  },
]

/** Decode bytes as text when they are clean UTF-8 without control characters. */
function asText(bytes) {
  const text = bytes.toString('utf8')
  if (Buffer.from(text, 'utf8').equals(bytes) && !/[\u0000-\u0008\u000e-\u001f]/.test(text)) return text
  return undefined
}

const ok = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value })
const fail = message => ({ content: [{ type: 'text', text: message }], isError: true })

export class McpGateway {
  /** @param {{ hub: any, clock?: () => number, ttlMs?: number }} options */
  constructor({ hub, clock, ttlMs = BEARER_TTL_MS }) {
    this.hub = hub
    this.clock = clock ?? hub.clock ?? Date.now
    this.ttlMs = ttlMs
    this.bearers = new Map() // token -> { agentId, exp }
  }

  /** client_credentials: the worker token proves the agent; a short bearer comes back. */
  async issueToken({ grant_type: grant, client_id: clientId, client_secret: secret } = {}) {
    if (grant !== 'client_credentials') throw oauthError(400, 'unsupported_grant_type', 'only client_credentials')
    if (typeof clientId !== 'string' || !AGENT_ID_RE.test(clientId) || typeof secret !== 'string') throw oauthError(401, 'invalid_client', 'client_id and client_secret are required')
    let who
    try { who = await this.hub.authenticateToken(secret) } catch { throw oauthError(401, 'invalid_client', 'invalid client credentials') }
    if (who.role !== 'worker' || who.id !== clientId) throw oauthError(401, 'invalid_client', 'invalid client credentials')
    this.prune()
    if (this.bearers.size >= MAX_BEARERS) throw oauthError(503, 'temporarily_unavailable', 'too many tokens; try again later')
    const token = `dshm_${randomBytes(24).toString('base64url')}`
    this.bearers.set(token, { agentId: clientId, exp: this.clock() + this.ttlMs })
    return { access_token: token, token_type: 'Bearer', expires_in: Math.round(this.ttlMs / 1000) }
  }

  prune() {
    const now = this.clock()
    for (const [token, b] of this.bearers) if (b.exp <= now) this.bearers.delete(token)
  }

  /** Bearer -> agent id (401 when missing, unknown, expired). */
  agentFor(authorization) {
    const m = typeof authorization === 'string' ? /^Bearer\s+(\S+)$/i.exec(authorization.trim()) : null
    const entry = m === null ? undefined : this.bearers.get(m[1])
    if (entry === undefined || entry.exp <= this.clock()) {
      if (entry !== undefined) this.bearers.delete(m[1])
      throw new HubError(401, 'unauthorized', 'missing or expired bearer token; get one at /oauth/token')
    }
    return entry.agentId
  }

  /** Forget every bearer of an agent (on revoke). */
  forget(agentId) { for (const [token, b] of this.bearers) if (b.agentId === agentId) this.bearers.delete(token) }

  /** One JSON-RPC message -> response object, or undefined for a notification. */
  async handle(message, agentId) {
    if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id ?? null, -32600, 'invalid request')
    }
    const notification = !Object.hasOwn(message, 'id')
    if (notification) return undefined
    const params = message.params ?? {}
    try {
      switch (message.method) {
        case 'initialize': {
          const asked = params.protocolVersion
          const version = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0]
          return rpcResult(message.id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS })
        }
        case 'ping': return rpcResult(message.id, {})
        case 'tools/list': return rpcResult(message.id, { tools: TOOLS })
        case 'tools/call': return rpcResult(message.id, await this.call(agentId, params.name, params.arguments ?? {}))
        default: return rpcError(message.id, -32601, `method not found: ${message.method}`)
      }
    } catch (error) {
      if (error instanceof HubError && error.status === 401) throw error // the bearer's agent was revoked
      return rpcError(message.id, -32603, 'internal error')
    }
  }

  /** A tool call. Hub refusals come back as tool errors the model can read. */
  async call(agentId, name, args) {
    const a = args !== null && typeof args === 'object' ? args : {}
    try {
      switch (name) {
        case 'next_task': {
          const { tasks } = await this.hub.lease(agentId, 1)
          return ok({ task: tasks[0] ?? null })
        }
        case 'get_input': {
          const bytes = await this.hub.artifact(agentId, { task_id: a.task_id, from_task: a.from_task, name: a.name })
          const text = asText(bytes)
          return ok(text === undefined ? { name: a.name, base64: bytes.toString('base64') } : { name: a.name, text })
        }
        case 'report_progress': return ok(await this.hub.progress(agentId, { task_id: a.task_id, progress: a.progress, message: a.message }))
        case 'submit_result': {
          const files = Array.isArray(a.files)
            ? a.files.map(f => ({ name: f?.name, base64: typeof f?.base64 === 'string' ? f.base64 : Buffer.from(String(f?.text ?? ''), 'utf8').toString('base64') }))
            : []
          return ok(await this.hub.submitResult(agentId, { task_id: a.task_id, status: a.status, summary: a.summary, files, needs_input: a.needs_input }))
        }
        case 'release_task': return ok(await this.hub.release(agentId, { task_id: a.task_id, reason: a.reason }))
        default: return fail(`unknown tool: ${name}`)
      }
    } catch (error) {
      if (error instanceof HubError) {
        if (error.status === 401) throw error
        return fail(`${error.code}: ${error.message}`)
      }
      throw error
    }
  }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result } }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } } }

/** OAuth errors use the RFC 6749 shape: { error, error_description }. */
export function oauthError(status, code, description) {
  const error = new HubError(status, code, description)
  error.oauth = true
  return error
}
