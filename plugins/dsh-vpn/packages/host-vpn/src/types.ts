/**
 * The host-plugin contract this package binds to, declared structurally.
 *
 * Same rule as `dsh-host-router`: no `@deepseek-ai/*` import at runtime or in
 * types, because the compatibility preflight in `dsh-app-boot` treats such a
 * peer as a hard version lock. Every shape below was read from the running
 * 0.2.2-rc.3 build (see `docs/API-0.2.2-rc.3.md` in dsh-router-b:
 * `ctx.tools.register`, `ctx.inject(['webServer'], …)`, `webServer.register`).
 *
 * @module host-vpn/types
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** One model-facing content block. Only text is produced here. */
export interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}

/** The plugin's logger surface. */
export interface LoggerService {
  info(message: string): void
  warn(message: string): void
}

/** A registered tool: schema plus body. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: { readonly signal: AbortSignal }): Promise<unknown>
  isConcurrencySafe?(args: unknown): boolean
}

/** One HTTP route, as `@deepseek-ai/dsh-host-webserver` declares it (`WebRoute`). */
export interface WebRouteLike {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
}

/** The `ctx.webServer` seam, limited to route registration. */
export interface WebServerLike {
  register(route: WebRouteLike): () => void
}

/** The context an `inject` callback receives. */
export interface InjectedPluginContext {
  readonly webServer: WebServerLike | undefined
  effect(run: () => () => void, label?: string): unknown
}

/** The Cordis plugin context, restricted to what this plugin touches. */
export interface PluginContext {
  readonly tools: { register(definition: ToolDefinition): () => void }
  readonly logger: LoggerService
  effect(run: () => (() => void) | void, label?: string): unknown
  inject?(deps: readonly string[], callback: (context: InjectedPluginContext) => void): unknown
}
