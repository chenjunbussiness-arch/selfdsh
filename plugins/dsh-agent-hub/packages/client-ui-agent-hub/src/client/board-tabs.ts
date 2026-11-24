/**
 * Cross-plugin tab extension point of the router task board (工作板).
 *
 * THIS FILE EXISTS TWICE, BYTE FOR BYTE:
 *   plugins/dsh-router-b/packages/client-ui-router/src/client/board-tabs.ts
 *   plugins/dsh-agent-hub/packages/client-ui-agent-hub/src/client/board-tabs.ts
 * Edit both or neither. An incompatible change must bump {@link REGISTRY_VERSION}.
 *
 * Why a global and not an import: each plugin ships its own client bundle, built
 * on its own, so neither can import the other at build time, and the Web module
 * loader has no table entry for a third-party plugin. What both bundles do share
 * is the page (`globalThis`) and the host's single React instance, so a component
 * one bundle registers here can be rendered by the other.
 *
 * Contract (version 1):
 *   - the registry lives at `globalThis.__dshRouterBoardTabs__` and carries
 *     `v: 1`; whichever bundle evaluates first creates it, the other reuses it,
 *     so load order does not matter;
 *   - a producer calls `register({ id, order, label, Component, badge?, flag? })` and
 *     keeps the returned disposer; a second registration with the same `id`
 *     replaces the first (the first one's disposer then does nothing);
 *   - a producer calls `notify()` when what `label()`, `badge()` or `flag()` would answer
 *     has changed, so consumers re-read;
 *   - the consumer (the router board) calls `consume(name)` once when its plugin
 *     starts and reads `list()` through `subscribe` (React `useSyncExternalStore`);
 *   - `hasConsumer()` says whether any board declared itself, so a producer can
 *     fall back to a surface of its own when no board is installed;
 *   - the consumer renders `Component` with `{ embedded: true, onClose? }`.
 *
 * `flag` (added within version 1, optional) is a small attention dot with a
 * reason text; a board that predates it simply ignores it, and a registry
 * created by a build that predates it never evaluates it, so it degrades to
 * "no dot" without breaking anything.
 *
 * `list()` evaluates every `label()` / `badge()` / `flag()` (a throwing one is contained)
 * and returns the SAME array as long as nothing it holds changed: React's
 * `useSyncExternalStore` needs a referentially stable snapshot.
 *
 * No Harness package and no React value is imported: the file must build in both
 * bundles unchanged.
 */

/** `globalThis` property the registry lives under. */
export const REGISTRY_KEY = '__dshRouterBoardTabs__'

/** Contract version stored as `v` on the registry. */
export const REGISTRY_VERSION = 1

/** Props the board passes to an extension tab's component. */
export interface BoardTabProps {
  /** Always true: the component is drawn inside the board's tab body. */
  readonly embedded: true
  /** Hide the whole board again; absent when the shell has no right Sidebar. */
  readonly onClose?: () => void
}

/**
 * An extension tab's body: a React function component, typed structurally so
 * this file needs no React types. The consumer casts it when rendering.
 */
export type BoardTabComponent = (props: BoardTabProps) => unknown

/** What a producer registers. */
export interface BoardTabDefinition {
  /** Unique id; the board addresses the tab as `ext:${id}`. */
  readonly id: string
  /**
   * Ascending position; ties keep registration order. 0 and up: after the
   * built-in tabs. Below 0 (added within version 1): before them, and the first
   * such tab opens by default, until the person picks a tab. A board that
   * predates this draws it after its own tabs, which still works.
   */
  readonly order: number
  /** Tab caption, read on every snapshot so a locale switch shows at once. */
  readonly label: () => string
  /** Tab body. */
  readonly Component: BoardTabComponent
  /** Optional count shown on the tab; `undefined` or 0 shows nothing. */
  readonly badge?: () => number | undefined
  /**
   * Optional attention dot. A non-empty string shows the dot and is used as its
   * tooltip / accessible label (at most 200 characters are kept); `undefined`
   * or an empty string shows nothing. Independent of `badge`.
   */
  readonly flag?: () => string | undefined
}

/** One tab as the consumer sees it: label and badge already evaluated. */
export interface BoardTabView {
  readonly id: string
  readonly order: number
  readonly label: string
  /** A positive integer, or `undefined` for no badge. */
  readonly badge: number | undefined
  /** Reason text of the attention dot, or `undefined` for no dot. */
  readonly flag?: string | undefined
  readonly Component: BoardTabComponent
}

/** The registry shared through `globalThis`. */
export interface BoardTabRegistry {
  /** Contract version. */
  readonly v: 1
  /**
   * Add (or replace, by `id`) one tab.
   * @param tab - the tab.
   * @returns disposer removing exactly this registration.
   */
  register(tab: BoardTabDefinition): () => void
  /** Tabs sorted by `order`; the same array while nothing changed. */
  list(): readonly BoardTabView[]
  /**
   * Listen for any change: tabs, a producer's `notify()`, or consumers.
   * @param listener - called synchronously after the change.
   * @returns disposer removing the listener.
   */
  subscribe(listener: () => void): () => void
  /** Producer side: `label()`, `badge()` or `flag()` may answer differently now. */
  notify(): void
  /**
   * Consumer side: declare a board that renders these tabs.
   * @param name - diagnostic name of the consuming plugin.
   * @returns disposer withdrawing the declaration.
   */
  consume(name: string): () => void
  /** Whether at least one board declared itself through `consume`. */
  hasConsumer(): boolean
}

interface Slot {
  readonly def: BoardTabDefinition
  readonly seq: number
}

/** Call a producer's function without letting it break the board. */
function guard<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch (error) {
    console.error('[board-tabs] an extension tab threw while being read', error)
    return fallback
  }
}

/** Normalise a badge answer: a positive integer or nothing. */
function badgeOf(def: BoardTabDefinition): number | undefined {
  if (def.badge === undefined) return undefined
  const value = guard(def.badge, undefined)
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.floor(value)
}

/** Normalise a flag answer: a trimmed non-empty string (max 200 chars) or nothing. */
function flagOf(def: BoardTabDefinition): string | undefined {
  if (typeof def.flag !== 'function') return undefined
  const value = guard(def.flag, undefined)
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text.slice(0, 200)
}

/** Build a fresh registry. */
function createRegistry(): BoardTabRegistry {
  const slots = new Map<string, Slot>()
  const listeners = new Set<() => void>()
  const consumers = new Map<object, string>()
  let seq = 0
  let sorted: readonly Slot[] | undefined
  let snapshot: readonly BoardTabView[] = Object.freeze([])

  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[board-tabs] a listener threw', error)
      }
    }
  }

  return {
    v: 1,
    register(tab) {
      if (tab === null || typeof tab !== 'object' || typeof tab.id !== 'string' || tab.id === '') {
        throw new TypeError('board-tabs: register() needs a non-empty string id')
      }
      if (tab.Component === null || tab.Component === undefined) {
        throw new TypeError(`board-tabs: tab "${tab.id}" has no Component`)
      }
      seq += 1
      const slot: Slot = { def: tab, seq }
      slots.set(tab.id, slot)
      sorted = undefined
      emit()
      let live = true
      return () => {
        if (!live) return
        live = false
        // Replaced by a later registration under the same id: not ours to remove.
        if (slots.get(tab.id) !== slot) return
        slots.delete(tab.id)
        sorted = undefined
        emit()
      }
    },
    list() {
      if (sorted === undefined) {
        const orderOf = (slot: Slot): number => (Number.isFinite(slot.def.order) ? slot.def.order : 0)
        sorted = [...slots.values()].sort((left, right) => orderOf(left) - orderOf(right) || left.seq - right.seq)
      }
      const next = sorted.map((slot): BoardTabView => ({
        id: slot.def.id,
        order: Number.isFinite(slot.def.order) ? slot.def.order : 0,
        label: guard(() => String(slot.def.label()), slot.def.id),
        badge: badgeOf(slot.def),
        flag: flagOf(slot.def),
        Component: slot.def.Component,
      }))
      const same = next.length === snapshot.length && next.every((view, index) => {
        const old = snapshot[index]
        return old !== undefined && old.id === view.id && old.order === view.order && old.label === view.label
          && old.badge === view.badge && old.flag === view.flag && old.Component === view.Component
      })
      if (!same) snapshot = Object.freeze(next.map(view => Object.freeze(view)))
      return snapshot
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    notify() {
      emit()
    },
    consume(name) {
      const token = {}
      consumers.set(token, String(name))
      emit()
      let live = true
      return () => {
        if (!live) return
        live = false
        consumers.delete(token)
        emit()
      }
    },
    hasConsumer() {
      return consumers.size > 0
    },
  }
}

/** A value on `globalThis` that speaks this contract version. */
function isRegistry(value: unknown): value is BoardTabRegistry {
  if (typeof value !== 'object' || value === null) return false
  const probe = value as Partial<BoardTabRegistry>
  return probe.v === REGISTRY_VERSION && typeof probe.register === 'function' && typeof probe.list === 'function'
    && typeof probe.subscribe === 'function' && typeof probe.notify === 'function'
    && typeof probe.consume === 'function' && typeof probe.hasConsumer === 'function'
}

let local: BoardTabRegistry | undefined

/**
 * The shared registry, created on first use by whichever bundle asks first.
 *
 * A value of another contract version already sitting under the key is left
 * alone (it belongs to a newer or older build of the other plugin): this bundle
 * then works on a private registry and says so once in the console, so the two
 * plugins degrade to "no shared tab" instead of calling an API they disagree on.
 * @returns the registry.
 */
export function boardTabs(): BoardTabRegistry {
  const scope = globalThis as unknown as Record<string, unknown>
  const existing = scope[REGISTRY_KEY]
  if (isRegistry(existing)) return existing
  if (local !== undefined) return local
  const created = createRegistry()
  if (existing !== undefined) {
    console.warn(`[board-tabs] globalThis.${REGISTRY_KEY} speaks another version; this bundle keeps a private registry`)
    local = created
    return created
  }
  try {
    Object.defineProperty(scope, REGISTRY_KEY, { value: created, writable: false, enumerable: false, configurable: true })
  } catch {
    // A frozen global: keep it private; nothing else breaks.
    local = created
  }
  return created
}
