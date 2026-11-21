/**
 * The host-plugin contract this package binds to, declared structurally.
 *
 * Same convention as `dsh-host-router`: no `@deepseek-ai/*` import at runtime or
 * for types, so the package type-checks and loads on any DSH build. Shapes were
 * read from the running build (`ctx.tools.register`, `ctx.inject(['webServer'])`,
 * `webServer.register({ kind, path, handler })`).
 *
 * @module host-egress/types
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** One model-facing content block. */
export interface ContentBlock {
    readonly type: 'text';
    readonly text: string;
}
/** The plugin's logger surface. */
export interface LoggerService {
    info(message: string): void;
    warn(message: string): void;
}
/** A registered tool: schema plus body. */
export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly output: {
        readonly schema: Record<string, unknown>;
        render(args: unknown, value: unknown): ContentBlock[];
    };
    execute(args: unknown, exec: {
        readonly signal: AbortSignal;
    }): Promise<unknown>;
    isConcurrencySafe?(args: unknown): boolean;
}
/** One HTTP route, as `@deepseek-ai/dsh-host-webserver` declares it. */
export interface WebRouteLike {
    readonly kind: 'exact' | 'prefix';
    readonly path: string;
    handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>;
}
/** The `ctx.webServer` seam, limited to route registration. */
export interface WebServerLike {
    register(route: WebRouteLike): () => void;
}
/** The Cordis plugin context, restricted to what this plugin touches. */
export interface PluginContext {
    readonly tools: {
        register(definition: ToolDefinition): () => void;
    };
    readonly logger: LoggerService;
    effect(run: () => () => void, label?: string): unknown;
    inject?(deps: readonly string[], callback: (context: InjectedPluginContext) => void): unknown;
}
/** The context an `inject` callback receives. */
export interface InjectedPluginContext extends PluginContext {
    readonly webServer: WebServerLike | undefined;
}
/** One model endpoint the operator wants listed before any request was seen. */
export interface ProviderConfig {
    /** Display label only; the binding key is the host of `baseURL`. */
    readonly name: string;
    readonly baseURL: string;
}
/** Plugin config (all optional). */
export interface EgressConfig {
    readonly dataDir?: string;
    readonly providers?: readonly ProviderConfig[];
    readonly undiciPath?: string;
}
