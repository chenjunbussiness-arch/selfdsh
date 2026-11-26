/**
 * The host-plugin contract this package binds to, declared structurally.
 *
 * Why these types are local rather than imported from `@deepseek-ai/*`:
 *
 * - The runtime and the source checkout in this workspace are different rc
 *   builds (running desktop 0.2.2-rc.3 / cordis 4.1.0, checkout 0.2.2-rc.5).
 *   Importing the checkout's sources would type-check against the wrong build,
 *   and it would drag that whole project graph into this package's program.
 * - Every field below was read out of the *running* build's bundled JavaScript
 *   (`.../app.asar/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js` and
 *   `dsh-tool-subagent/lib/index.js`) rather than guessed from a README, so the
 *   shapes track the API this plugin actually calls. `README.md` records the
 *   exact call sites.
 *
 * The narrow structural surface is also the point: this plugin only needs the
 * subagent seam, a tool registry, an event bus, and a logger. Anything wider
 * would be an unverified assumption.
 *
 * @module host-router/types
 */
/** One model-facing content block. Only text is produced here. */
export interface ContentBlock {
    readonly type: 'text';
    readonly text: string;
}
/** The durable session facts this plugin reads from a live Agent. */
export interface AgentSession {
    readonly id: string;
    readonly header: {
        readonly id: string;
        /** The session's creation directory; NOT its current one. */
        readonly cwd?: string;
    };
}
/**
 * A live Agent, as far as this plugin is concerned.
 *
 * `ctx.agents.get(id)` is the only source of these; holding one across a turn
 * boundary does not prove it is still live, which is why every dispatch
 * re-resolves its parent instead of caching one.
 */
export interface LiveAgent {
    readonly id: string;
    readonly session: AgentSession;
    /**
     * The Agent's own Cordis context. Present on every real Agent; optional here
     * so test doubles stay valid. The router reads `ctx.systemPrompt` from it to
     * give the anchor its dispatcher instructions.
     */
    readonly ctx?: unknown;
    /** `dsh-agent-loop` `followup`: queue a message for the next turn and wake the loop. */
    followup?(message: unknown): void;
    /** `dsh-agent-loop` `inject`: queue a message for the next step without waking the loop. */
    inject?(message: unknown): void;
    /** Idle or running; read to pick queue vs steer. */
    readonly status?: string;
    /** `dsh-agent-loop` inbox: messages not taken yet, which can be replaced or removed. */
    readonly inbox?: AgentInbox;
}
/** The part of a DSH Agent's inbox the router uses to keep one progress notice queued. */
export interface AgentInbox {
    readonly nextTurn?: readonly unknown[];
    readonly nextStep?: readonly unknown[];
    replace?(messageId: unknown, message: unknown): boolean;
    remove?(messageId: unknown): unknown;
}
/** Why a child run ended, in the subagent seam's vocabulary. */
export type StopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | (string & {});
/** What one finished child produced. */
export interface SubagentResult {
    /** The child's final assistant message blocks. */
    readonly output: readonly ContentBlock[];
    readonly stopReason: StopReason;
}
/**
 * One managed child execution returned by `startActivation`.
 *
 * `result` settles after the child's teardown; `dispose()` stops exactly this
 * activation. The plugin uses `result` to close its board row and never
 * disposes a naturally settled child (the runtime already does that).
 */
export interface SubagentActivation {
    readonly childId: string;
    /** Model-facing name inside the subagent tree, e.g. `agent-2`. */
    readonly name: string;
    readonly messageId?: string;
    readonly result: Promise<SubagentResult>;
    dispose(): Promise<void>;
}
/**
 * One start request for the `spawn` provider.
 *
 * `cwd` is the load-bearing field. `SubagentManager.resolveDirectory` uses an
 * absolute `cwd` verbatim, and the local materializer then calls
 * `workingDirectory.set(child, cwd)` before the child's first turn — so the
 * child's *working directory service value* is the partition root even though
 * `session.header.cwd` still records the parent's creation directory. That is
 * what makes sandbox writes land inside the partition, and it means a worker
 * never has to "cd first".
 */
export interface ActivationSpec {
    readonly provider: string;
    readonly label: string;
    readonly name?: string;
    /** Absolute directory the child is rooted in. */
    readonly cwd?: string;
    readonly prompt: readonly ContentBlock[];
    readonly parent: LiveAgent;
    readonly signal: AbortSignal;
    /** `parent` lets the runtime deliver the child's closing report to its creator. */
    readonly delivery: 'parent' | 'caller';
    readonly agentPreset?: string;
    readonly agentOptions?: {
        readonly provider?: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
        readonly maxTokens?: number;
    };
    readonly maxDepth?: number;
}
/** Authority for interrupting a child. `user` is the trusted host operation. */
export type InterruptAuthority = {
    readonly kind: 'user';
} | {
    readonly kind: 'ancestor';
    readonly agent: LiveAgent;
};
/** The `ctx.subagents` seam, limited to the three operations used here. */
export interface SubagentsService {
    startActivation(spec: ActivationSpec): Promise<SubagentActivation>;
    sendMessage(sender: LiveAgent, targetId: string, content: readonly ContentBlock[], options: {
        readonly signal: AbortSignal;
    }): Promise<string>;
    interrupt(targetSessionId: string, authority: InterruptAuthority): void;
}
/** The agent registry, limited to liveness lookup. */
export interface AgentsService {
    get(id: string): LiveAgent | undefined;
    /**
     * Create and publish a new root Agent through the registered factory.
     *
     * `dsh-agent/src/index.ts:410`. Optional on this shim so a test double that
     * only needs lookups stays valid; the router treats absence as "cannot
     * anchor", never as an error.
     */
    readonly create?: (options: CreateAgentRequest) => Promise<AgentHandleLike>;
    /**
     * Resume a persisted Session as a live Agent (`dsh-agent` `agents.resume`).
     * Rejects when the session is unknown or already owned.
     */
    readonly resume?: (options: {
        readonly resumeSessionId: string;
        readonly agentOptions?: CreateAgentRequest['agentOptions'];
        readonly setup?: CreateAgentRequest['setup'];
    }) => Promise<AgentHandleLike>;
}
/** Minimal {@link AgentsService.create} request the router needs. */
export interface CreateAgentRequest {
    readonly sessionId: string;
    readonly meta?: {
        readonly cwd?: string;
        readonly agentPreset?: string;
    };
    /**
     * Route and output controls. Required in practice: a fresh Agent with no
     * selection fails its first turn with "has no provider/model".
     */
    readonly agentOptions?: {
        readonly provider?: string;
        readonly model?: string;
        readonly reasoningEffort?: string;
    };
    /**
     * Pre-publication setup run in the fresh Agent context. `meta.agentPreset`
     * only records the header; the preset's tools are mounted here, exactly as
     * `dsh-api-session-controller/src/agent.ts` `composeAgent` does.
     */
    readonly setup?: (agentCtx: unknown, agent: unknown) => void | Promise<void>;
}
/** The `ctx.agentPresets` registry, limited to the two calls the anchor needs. */
export interface AgentPresetsService {
    /** `dsh-agent-preset-registry/src/index.ts` `resolve`: rejects an unknown id. */
    resolve(id?: string): Promise<{
        readonly id: string;
    }>;
    /** Bind an unpublished Agent context to the preset. */
    mount(ctx: unknown, id?: string): Promise<{
        readonly id: string;
    }>;
}
/** Default model selection for Agents created without an explicit one. */
export interface AgentDefaultModelService {
    /** `dsh-agent-default-model/src/index.ts:67`. */
    currentSelection(): {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    };
}
/** The handle `create` resolves to; `dispose` tears down exactly that Agent. */
export interface AgentHandleLike {
    readonly agent: LiveAgent;
    dispose(): Promise<void>;
}
/**
 * One durable session event, as this plugin reads it.
 *
 * Deliberately opaque: `type` plus an unknown `data` payload lets the snapshot
 * folder accept any event and read only the two it understands (`todo/write`,
 * `turn/start`, `turn/end`, `assistant/message`) without binding to the full
 * event union of one rc build.
 */
export interface SessionEventLike {
    readonly type: string;
    readonly seq: number;
    readonly time: number;
    readonly data?: unknown;
}
/**
 * The session-query service, limited to the exact read this plugin needs.
 *
 * `readSession` clones a complete log for a live or persisted session and never
 * makes a cold session live, so a worker's progress can be read while it runs
 * and after it has been disposed.
 */
export interface SessionQueryService {
    readSession(sessionId: string): Promise<{
        readonly session: {
            readonly id: string;
        };
        readonly events: readonly SessionEventLike[];
    }>;
    /**
     * Every persisted Session record, newest last.
     *
     * `dsh-session-query/src/index.ts:186`. Used to find a live Agent when a
     * demand arrives with no producing Agent behind it.
     */
    listSessions(signal?: AbortSignal): Promise<readonly {
        readonly id: string;
    }[]>;
}
/** One raw JSON Schema node of the enforced subset. */
export type JsonSchemaNode = Record<string, unknown>;
/** The execution context a tool body receives. */
export interface ToolRunContext {
    /** The calling agent; absent for a host-initiated call. */
    readonly agent?: LiveAgent;
    readonly signal: AbortSignal;
}
/** A registered tool: schema plus body. */
export interface ToolDefinition {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchemaNode;
    readonly output: {
        readonly schema: JsonSchemaNode;
        render(args: unknown, value: unknown): ContentBlock[];
    };
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
    isConcurrencySafe?(args: unknown): boolean;
}
/** The tool registry. */
export interface ToolsService {
    register(definition: ToolDefinition): () => void;
}
/** The plugin's logger surface. */
export interface LoggerService {
    info(message: string): void;
    warn(message: string): void;
}
/**
 * One HTTP route, as `@deepseek-ai/dsh-host-webserver` declares it.
 *
 * Copied from the running 0.2.2-rc.3 build's source rather than imported:
 * `…/app.asar/dsh/node_modules/@deepseek-ai/dsh-host-webserver/src/index.ts:52-58`
 * (`WebRoute`: `kind: 'exact' | 'prefix'`, `path`, and a `handler` that owns the
 * whole `node:http` response lifecycle — which is what makes SSE possible).
 *
 * A `handler` route answers every method; a `resource` route
 * (`WebResourceRoute`, same file `:68-74`) answers only GET and HEAD and is
 * therefore unusable for the bridge's POST endpoints.
 */
export interface WebRouteLike {
    /** `exact` matches the pathname verbatim; `prefix` matches it and everything under it. */
    readonly kind: 'exact' | 'prefix';
    /** Absolute pathname, no trailing slash. */
    readonly path: string;
    /** Owns the response lifecycle and must end the response (an SSE stream stays open). */
    handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void | Promise<void>;
}
/**
 * The `ctx.webServer` seam, limited to route registration.
 *
 * `register(route)` is the only method this plugin calls; it is declared at
 * `@deepseek-ai/dsh-host-webserver/src/index.ts:445` in the running build and
 * returns a disposer that removes the route again.
 */
export interface WebServerLike {
    register(route: WebRouteLike): () => void;
}
/**
 * Read-only credential presence, as far as this plugin asks.
 *
 * `ctx.credentials.describe(ref)` answers "is a value stored for this
 * reference" and never returns the value itself
 * (`@deepseek-ai/dsh-credentials/src/index.ts:186-192`). Only `configured` is
 * read here, so no secret ever reaches the board document.
 */
export interface CredentialsServiceLike {
    describe(ref: string): Promise<{
        readonly configured?: unknown;
        readonly source?: unknown;
        readonly writable?: unknown;
    }>;
    /** The stored value (credential store first, then env fallbacks); optional on old hosts. */
    resolve?(ref: string): Promise<{
        readonly value?: unknown;
    } | undefined>;
}
/**
 * The sandbox policy service, limited to the one grant this plugin needs.
 *
 * In the running 0.2.2-rc.3 build, `sessionWorkspaceRoot()` reads
 * `session.header.cwd` only — a child rooted in another directory does NOT
 * inherit write permission there. `registerWritableRoot` is the runtime grant
 * that closes the gap; it is runtime-only (re-register after resume) and, on
 * Windows, applies to harness file tools rather than to sandboxed processes.
 */
export interface SandboxPolicyService {
    registerWritableRoot(session: unknown, directory: string): unknown;
}
/** One raw stream chunk from `ctx.llm`, narrowed to what the classifier reads. */
export type LlmChunkLike = {
    readonly type: 'text-delta';
    readonly index: number;
    readonly text: string;
} | {
    readonly type: 'finish';
    readonly reason?: {
        readonly kind: string;
        readonly failure?: {
            readonly message?: string;
        };
    };
} | {
    readonly type: Exclude<string, 'text-delta' | 'finish'>;
    readonly text?: unknown;
    readonly reason?: undefined;
};
/** Model metadata the classifier reads when choosing a reasoning effort. */
export interface LlmModelInfoLike {
    readonly reasoning?: {
        readonly efforts?: readonly {
            readonly id: string;
        }[];
    };
}
/**
 * The `ctx.llm` runtime, limited to `prepareCall` + `stream`.
 *
 * Shape copied from `@deepseek-ai/dsh-llm/src/index.ts` (`LlmRuntime.prepareCall`,
 * `PreparedLlmCall`) and `types.ts` (`StreamChunk`, `GenerateOptions`). A
 * `RequestUserInput` (`{ role: 'user', content }`, no id/source) is a valid
 * request message, so no `createUserMessage` import is needed.
 */
export interface LlmRuntimeLike {
    /** `dsh-llm` `listProviders`; optional so test doubles stay valid. */
    listProviders?(): readonly {
        readonly id: string;
        readonly name: string;
    }[];
    /** `dsh-llm` `listModels`. */
    listModels?(provider: string): Promise<readonly {
        readonly id: string;
        readonly name: string;
    }[]>;
    /** `dsh-llm` `resolveModelInfo`, read for reasoning efforts. */
    resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<LlmModelInfoLike>;
    prepareCall(config: {
        readonly provider: string;
        readonly model: string;
        readonly maxTokens?: number;
    }, signal?: AbortSignal, configure?: (controls: Record<string, unknown>, model: LlmModelInfoLike) => Record<string, unknown>): Promise<{
        readonly config: Record<string, unknown> & {
            readonly provider: string;
            readonly model: string;
        };
        stream(options: Record<string, unknown>): AsyncIterable<LlmChunkLike>;
    }>;
}
/**
 * The Cordis plugin context, restricted to what this plugin touches.
 *
 * `get` rather than property access for optional services, matching the host
 * plugin convention: a missing optional service must degrade, not fail the row.
 */
export interface PluginContext {
    get(name: 'subagents'): SubagentsService | undefined;
    get(name: 'agents'): AgentsService | undefined;
    get(name: 'agentDefaultModel'): AgentDefaultModelService | undefined;
    get(name: 'sessionQuery'): SessionQueryService | undefined;
    get(name: 'sandboxPolicy'): SandboxPolicyService | undefined;
    get(name: 'agentPresets'): AgentPresetsService | undefined;
    get(name: 'llm'): LlmRuntimeLike | undefined;
    get(name: string): unknown;
    readonly tools: ToolsService;
    readonly logger: LoggerService;
    on(event: string, listener: (...args: readonly never[]) => void): () => void;
    effect(run: () => () => void, label?: string): unknown;
    /**
     * Cordis's service-scoped child context: the callback runs only while every
     * named service is available, and re-runs when one is replaced. This is how
     * the shipped plugins mount HTTP routes on an optional `webServer`
     * (`dsh-client-connection/src/index.ts:141-165`), and why the bridge does not
     * have to race the web server's activation.
     */
    inject?(deps: readonly string[], callback: (context: InjectedPluginContext) => void): unknown;
    /**
     * Cordis's service publication entry point. Optional in this contract because
     * the plugin feature-detects it: the durable JSON snapshot is the guaranteed
     * client contract, and this only adds an in-process handle when the running
     * cordis build offers one.
     */
    set?(name: string, value: unknown): void;
    /**
     * Cordis's service registration. `set` only overwrites a service that was
     * already provided (it throws "cannot set property ... without provide"), so
     * a new service has to be provided first. Feature-detected like `set`.
     */
    provide?(name: string, value?: unknown): unknown;
}
/**
 * The context an `inject` callback receives: the plugin's own context plus the
 * services it asked for.
 *
 * `webServer` stays optional even here, because the declaration is structural:
 * a cordis build that publishes the service under a different shape must
 * degrade to "no bridge" instead of throwing during activation.
 */
export interface InjectedPluginContext extends PluginContext {
    readonly webServer: WebServerLike | undefined;
}
