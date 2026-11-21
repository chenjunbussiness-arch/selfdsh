/**
 * Vendored subset of the DeepSeek Harness 0.2.2-rc.3 browser-facing types.
 *
 * WHY THIS FILE EXISTS
 * -------------------
 * A Harness Client plugin runs inside the Web shell's module loader, so it must
 * NOT `require()` any `@deepseek-ai/dsh-*` package at runtime (that rule is
 * stated in the shipped authoring guide,
 * `dsh-agent-preset/skills/dsh-doc/references/practices.md`, "Do not
 * `require('@deepseek-ai/dsh-client-ui-primitives')` …"). Value imports of
 * Harness packages are therefore impossible, and those packages are not on this
 * package's disk. Type-only imports are erased at emit time, which is legal, but
 * they still need declarations to type-check against.
 *
 * Every declaration below is copied from the RUNNING 0.2.2-rc.3 sources inside
 * `resources/app.asar/dsh/node_modules/@deepseek-ai/` (see the per-block source
 * references) and intentionally narrowed to what this plugin uses.
 *
 * In-repo replacement: delete this file and type against the real packages via
 * `packages/client/ui-slots`, `packages/client/locale`, and
 * `packages/client/ui-sidebar-right` project references. Nothing else changes.
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Snapshot source: the framework's read-only observable shape. */
  export interface HostObservable<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
  }

  /** A snapshot source that may also expose `set` on the producing side. */
  export type ObservableSnapshot<T> = HostObservable<T>

  /** One registration's options, structural subset of the renderer's contract. */
  export interface SlotRegisterOptions {
    /** Slot name this entry belongs to (_source: ui-renderer/src/client/registry.ts_). */
    name: string
    /** Keyed slots: the dispatch key. */
    key?: string
    /** List slots: the entry id. */
    id?: string
    /** Ascending order inside a list slot; ties keep registration order. */
    order?: number
    /** List slots: the row/section label. */
    label?: () => string
    /** Locale namespace the component's `t` is bound to. */
    locale?: string
    /** A store factory result seated for the component's `useStore`. */
    store?: unknown
    /** Registrant-private injected face; receives the slot's standard argument. */
    inject?: (argument: never) => Record<string, unknown>
    /** Child slot declarations owned by this entry. */
    children?: Record<string, { kind: 'single' | 'list' | 'keyed' | 'chain'; scope: 'root' | 'session' }>
  }

  /** The `ctx.slots` face. */
  export interface SlotsService {
    /**
     * Register a component into a declared slot.
     * @param options - slot address plus locale/store/inject.
     * @param component - the React component.
     * @returns disposer removing the entry.
     */
    register(options: SlotRegisterOptions, component: unknown): () => void
    /**
     * Install registrations only while the owner slot has a live declaration.
     * @param key - the owner slot name.
     * @param callback - registers/returns disposers (generator allowed).
     * @returns disposer removing the whole effect.
     */
    inject(key: string, callback: () => unknown): () => void
    /** Entries currently registered in a slot. */
    entries(key: string): readonly unknown[]
  }

  /** Resolve a localized key inside a namespace-bound translate. */
  export type Translate = (key: string, values?: Record<string, string | number>) => string
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  /** Dictionaries keyed by locale id; the shell falls back to `en`. */
  export type LocaleDict = Record<string, string>

  /** `ctx.locale` face (_source: dsh-client-locale/src/client/index.ts_). */
  export interface LocaleService {
    /**
     * Register dictionaries for one namespace.
     * @param ns - namespace id, also the `LocaleNamespaceMap` key.
     * @param dictionaries - locale id → dictionary.
     * @returns disposer removing every locale this call added.
     */
    register(ns: string, dictionaries: Record<string, LocaleDict>): () => void
    /**
     * Bind a namespace.
     * @param ns - registered namespace id.
     * @returns translate function resolving through the namespace chain.
     */
    bind(ns: string): (key: string, values?: Record<string, string | number>) => string
  }

  /** Namespace-bound translate, as consumed by slot components. */
  export type TranslateNS<NS extends string> = (key: string, values?: Record<string, string | number>) => string
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  /** Tab priority band; an outside type defaults to `extension`. */
  export type SidebarRightTabPriority = 'extension' | 'builtin' | 'fallback'

  /**
   * A right-Sidebar tab type (_source:
   * ui-sidebar-right/src/client/tab-registry.ts_). Registration is the only way
   * to add a type; `id` is the key its body and title register under.
   */
  export interface SidebarRightTabDefinition {
    /** Unique implementation identity across every registration. */
    readonly id: string
    /** Type discriminator; what `openTab` names. */
    readonly kind: string
    /** Each open by kind creates independent content when true. */
    readonly multiple?: boolean
    /** Keep a visited body mounted through hiding and Session changes. */
    readonly keepMounted?: boolean
    /** Resource-address globs; omit for a page type opened by kind. */
    readonly patterns?: readonly string[]
    /** Priority band; defaults to `extension`. */
    readonly priority?: SidebarRightTabPriority
    /** Veto an address this type's globs matched. */
    readonly canOpen?: (address: string) => boolean
    /** The tab chip's initial text, captured into the layout record at open. */
    readonly title?: (address: string) => string
  }

  /** Navigation parameters, free-form per tab kind. */
  export type SidebarRightTabParams = Record<string, unknown>

  /** Placement options for an open request. */
  export interface SidebarRightOpenOptions {
    /** Per-kind navigation parameters delivered to the body. */
    readonly params?: SidebarRightTabParams
    /** Prefer a new pane; falls back to the target pane. */
    readonly preferNewPane?: boolean
    /** Reveal already-open content; `false` permits duplicates. */
    readonly revealIfOpened?: boolean
    /** Land in this pane instead. */
    readonly paneId?: string
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right' {
  /** Re-exported so the panel can name its own contract types. */
  export type {
    SidebarRightTabDefinition,
    SidebarRightOpenOptions,
    SidebarRightTabParams,
    SidebarRightTabPriority,
  } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
}

declare module '@deepseek-ai/dsh-tool-todo/types' {
  /**
   * One entry of an agent's todo list — the unit of the `todo/write`
   * whole-list snapshot (_source: dsh-tool-todo/src/types.ts_).
   */
  export interface TodoItem {
    /** Short imperative line shown in the UI. */
    content: string
    /** Lifecycle state; parallel work may mark several `in_progress`. */
    status: 'pending' | 'in_progress' | 'completed'
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  /** Projection values the Host computes and the Client reads as whole values. */
  export interface SessionProjectionMap {
    /** The agent's current whole todo list, or `null` before the first write. */
    todos: import('@deepseek-ai/dsh-tool-todo/types').TodoItem[] | null
  }
}

declare module '@deepseek-ai/cordis' {
  import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'
  import type { LocaleService } from '@deepseek-ai/dsh-client-locale/client'
  import type {
    SidebarRightOpenOptions,
    SidebarRightTabDefinition,
  } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

  /** One Remote call's settled outcome (_source: dsh-api-remotes_). */
  export type RemoteResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

  /** The `ctx.remote` face, narrowed to what this plugin may call. */
  export interface RemoteFace {
    /**
     * Call `router/board` on the Host, plus the two rail actions the panel
     * offers when (and only when) the Host implements them.
     */
    router?: {
      board(): Promise<RemoteResult<unknown>>
      publish(request: { demands: readonly string[] }): Promise<RemoteResult<unknown>>
      verify(request: { taskId: string; verdict: 'verified' | 'rejected'; note?: string }): Promise<RemoteResult<unknown>>
      /**
       * Proposed `router/setPartitionEnabled`; not implemented by
       * `packages/host-router` yet, so the rail's switch reports itself unwired.
       * @param request - partition and the state to apply.
       */
      setPartitionEnabled?(request: { partitionId: string; enabled: boolean }): Promise<RemoteResult<unknown>>
      /**
       * Proposed `router/createPartition`; same status as above.
       * @param request - display name for the new partition.
       */
      createPartition?(request: { name: string }): Promise<RemoteResult<unknown>>
    }
    /**
     * `credentials` namespace (_source:
     * dsh-api-settings-controller/src/credentials.ts:83-119_). `describe`
     * answers `Record<ref, {configured, source?, writable, masked?}>` and never
     * returns a value; `set` is the same call the Models settings page makes.
     * Absent when the profile mounts no credential provider.
     */
    credentials?: {
      describe(refs: readonly string[]): Promise<RemoteResult<unknown>>
      set(ref: string, value: string): Promise<RemoteResult<unknown>>
      unset(ref: string): Promise<RemoteResult<unknown>>
    }
    /** Forwarded Host events; the router board publishes `router/changed`. */
    $on(event: string, listener: (payload: unknown) => void): () => void
  }

  /** The `ctx.sidebarRightTabs` face: tab-type registration. */
  export interface SidebarRightTabsService {
    /**
     * Register one tab type.
     * @param definition - id/kind/title/priority.
     * @returns disposer removing the type.
     */
    register(definition: SidebarRightTabDefinition): () => void
  }

  /** The `ctx.sidebarRight` face: navigation over the docking surface. */
  export interface SidebarRightService {
    /**
     * Open a page type.
     * @param kind - the type's kind.
     * @param options - placement and the kind's navigation parameters.
     */
    openTab(kind: string, options?: SidebarRightOpenOptions): void
    /** Committed tab ids of one Session. */
    tabsIn(sessionId: string): readonly { id: string }[]
    /**
     * Open a `dsh-resource://` address in the right column.
     * @param address - the resource address.
     * @param options - placement.
     */
    openResource?(address: string, options?: SidebarRightOpenOptions): void
  }

  /** The `ctx.uiWorkspace` face, narrowed to Session navigation. */
  export interface UiWorkspaceService {
    /**
     * Open an existing Session in the main column.
     * @param sessionId - the Session to show.
     */
    openSession(sessionId: string): void
  }

  /** Client root Context, narrowed to the services this plugin touches. */
  export interface Context {
    /** Slot registry and renderer face. */
    readonly slots: SlotsService
    /** Dictionaries and namespace binding. */
    readonly locale: LocaleService
    /** Right-Sidebar tab type registry. */
    readonly sidebarRightTabs: SidebarRightTabsService
    /** Right-Sidebar navigation. */
    readonly sidebarRight: SidebarRightService
    /** Workspace navigation; absent when the workspace plugin is not loaded. */
    readonly uiWorkspace?: UiWorkspaceService
    /**
     * Session catalog and projections (_source:
     * dsh-api-session-controller/src/client/contract/sessions.ts, ISessions).
     * Read for each worker's 	odos projection; absent only in a non-web shell.
     */
    readonly sessions?: {
      readonly list: {
        getSnapshot(): {
          readonly projectionsBySession?: Record<string, { readonly state?: string; readonly values?: Record<string, unknown> } | undefined>
        }
        subscribe(listener: () => void): () => void
      }
      refreshProjections?(sessionId: string): Promise<void>
    }
    /** Host Remotes; absent in a profile without the router bundle. */
    readonly remote?: RemoteFace
    /**
     * Own a side effect on this context.
     * @param callback - installs the effect, optionally returning a disposer.
     * @param label - diagnostic label.
     * @returns disposer running the callback's teardown once.
     */
    effect(callback: () => void | (() => void), label?: string): () => void
    /**
     * Run a callback only while every named service exists.
     * @param dependencies - service names that must be resolvable.
     * @param callback - receives the scope context.
     * @returns disposer removing the callback's registrations.
     */
    inject(dependencies: readonly string[], callback: (scope: Context) => void): () => void
    /** Structured logger supplied by the host. */
    readonly logger?: {
      error(...args: unknown[]): void
      warn(...args: unknown[]): void
    }
  }
}
