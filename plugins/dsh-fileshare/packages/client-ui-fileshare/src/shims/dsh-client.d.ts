/**
 * Vendored subset of the browser-facing Harness types this plugin touches.
 *
 * A client plugin runs inside the Web shell's module loader, so it must not
 * `require()` (or value-import) any `@deepseek-ai/dsh-*` package; type-only
 * imports are erased by esbuild, but they still need declarations. These are
 * narrowed copies of the running 0.2.2-rc.5 surfaces (same subset as
 * dsh-client-ui-token-stats, plus the `label` used by `sidebar.panellist`, as in
 * dsh-client-ui-vpn), kept next to the only module that imports them.
 */

declare module '@deepseek-ai/cordis' {
  /** One registration's options; list slots order ascending, ties keep registration order. */
  export interface SlotRegisterOptions {
    name: string
    key?: string
    id?: string
    order?: number
    label?: () => string
    locale?: string
    inject?: (argument: never) => Record<string, unknown>
  }

  /** The `ctx.slots` face, narrowed. */
  export interface SlotsService {
    register(options: SlotRegisterOptions, component: unknown): () => void
    inject(key: string, callback: () => unknown): () => void
  }

  /** The `ctx.locale` face, narrowed. */
  export interface LocaleService {
    register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: string, values?: Record<string, string | number>) => string
  }

  /** Client root Context, narrowed to the services this plugin touches. */
  export interface Context {
    readonly slots: SlotsService
    readonly locale: LocaleService
    effect(callback: () => void | (() => void), label?: string): () => void
    inject(dependencies: readonly string[], callback: (scope: Context) => void): () => void
  }
}
