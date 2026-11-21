/**
 * Browser entry of the router panel.
 *
 * It contributes three things and nothing else:
 *   1. a right-Sidebar tab type (`sidebarRightTabs.register`) plus its body in
 *      the keyed `sidebar.right.pane.tab` seat and its chip title;
 *   2. a header button in the conversation so the panel is reachable without a
 *      shortcut;
 *   3. its dictionaries.
 *
 * The panel draws its own left rail (projects + API-key status) inside the right
 * column: the app's left Sidebar has no free content seat for a third-party
 * plugin — `sidebar` is a single slot occupied by `dsh-client-ui-sidebar`, whose
 * content holes (`sidebar.workspaces`, `sidebar.settings`) belong to ui-workspace
 * and ui-settings, and whose free holes are navigation *rows*, not containers.
 * See `docs/NATIVE-ENTRYPOINTS.md`.
 *
 * No Harness package is imported as a value: a Client plugin runs inside the
 * Web module loader, where `@deepseek-ai/dsh-*` specifiers are module-table
 * entries, not dependencies (see the authoring guide shipped with the app,
 * `dsh-agent-preset/skills/dsh-doc/references/practices.md`). Everything is
 * React plus this package's own CSS.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { HostActions } from './contract.ts'
import { asCredentialViews } from './credentials.ts'
import { RouterBoardController } from './controller.ts'
import { RouterPanelTitle } from './RouterPanelTitle.tsx'
import { RouterPanelButton } from './RouterPanelButton.tsx'
import { BrandMark, BrandName } from './Brand.tsx'
import { RoutingIcon } from './RoutingIcon.tsx'
import { CompactBoard } from './CompactBoard.tsx'
import { WarRoomRedirect } from './WarRoomRedirect.tsx'
import { WorkspacePage } from './WorkspacePage.tsx'
import { WorkspaceIcon } from './WorkspaceIcon.tsx'
import { ModelTiers, installModelTierStyles } from './ModelTiers.tsx'
import { DICTIONARIES, NS } from './locales.ts'
import { installStyles } from './styles.ts'
import { createHostSource, createHttpActions, resolveSource, type BoardSource } from './source.ts'

/** Tab type id; also the key the body and title register under. */
export const TAB_ID = 'dsh-client-ui-router/board'

/** Tab kind the opener names. */
export const TAB_KIND = 'router-board'

/**
 * Key of the main panel, and the `id` of its Sidebar row.
 *
 * `main` is keyed, so this key sits beside the reserved `conversation` panel
 * rather than taking its place. The same value links the row to the panel: the
 * Sidebar selects the panel whose key equals the row's `id`.
 */
export const PANEL_ID = 'router/routing'

/** Main-panel key and Sidebar row id of the 工作区 page. */
export const WORKSPACE_ID = 'router/workspace'

/**
 * Services this plugin cannot work without.
 *
 * Deliberately minimal: the router Remote is NOT listed, so a profile without the
 * Host half still loads the panel and shows labelled sample data instead of
 * deactivating the plugin. Optional services are read defensively in `apply`.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']

/** Tab-type declaration, registered once. */
function boardTabDefinition(t: (key: string) => string): SidebarRightTabDefinition {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'extension',
    // One board for the whole profile, not one per Session: the panel reports on
    // every worker, so a second copy would say the same thing twice.
    multiple: false,
    keepMounted: true,
    title: () => t('panel.title'),
  }
}

/**
 * Register the panel.
 * @param ctx - Client Context carrying slots, locale, and the right Sidebar.
 */
export function apply(ctx: ClientContext): void {
  applyInner(ctx)
}

/**
 * Read a service the plugin does NOT declare in {@link inject}.
 *
 * Cordis 4.1 throws on `ctx.<name>` for any name the plugin did not inject, so
 * an optional service cannot be probed with a property read — the read itself
 * aborts `apply()` before a single slot registers. `ctx.get` is the supported
 * way to look up something that may legitimately be absent.
 * @param ctx - Client plugin context.
 * @param name - Service name to resolve.
 * @returns the service, or undefined when this profile does not provide it.
 */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof get !== 'function') return undefined
  return get.call(ctx, name) as T | undefined
}

/**
 * Read a property that cordis may refuse.
 *
 * A Remote is itself a context: reading a sub-service it does not expose throws
 * exactly like a top-level uninjected name. Every optional capability behind the
 * Remote is therefore probed through here, so a Host half that publishes only
 * part of the surface degrades to the HTTP bridge instead of aborting `apply()`.
 * @param read - thunk performing the property read.
 * @returns the value, or undefined when the read is refused or absent.
 */
function safeGet<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}


/** Loose view of the right Sidebar members the shim does not type. */
interface SidebarRightLoose {
  openTab(kind: string): void
  active?(): { id: string; kind: string } | undefined
  isExpanded?(): boolean
  hide?(tabId: string): void
}

/** Cached anchor id; the Host keeps one per profile. */
let anchorId: string | undefined

/**
 * Open the 作战室 Session.
 * @param ctx - client context.
 * @returns true once the open was issued.
 */
async function openAnchor(ctx: ClientContext): Promise<boolean> {
  const ui = optionalService<NonNullable<ClientContext['uiWorkspace']>>(ctx, 'uiWorkspace')
  if (ui === undefined) return false
  if (anchorId === undefined) {
    try {
      const response = await fetch('/api/router/anchor')
      if (!response.ok) return false
      const body = await response.json() as { sessionId?: unknown }
      if (typeof body.sessionId !== 'string') return false
      anchorId = body.sessionId
    } catch {
      return false
    }
  }
  try {
    ui.openSession(anchorId)
    return true
  } catch {
    return false
  }
}
function applyInner(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'client-ui-router: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.sidebarRightTabs.register(boardTabDefinition(t)), 'client-ui-router: tab type')

  // Header button: open the board tab, or hide it when it is the tab on show.
  const openWarRoom = (): void => { void openAnchor(ctx) }
  const toggleBoard = (): void => {
    const right = ctx.sidebarRight as unknown as SidebarRightLoose
    const active = right.active?.()
    if (active !== undefined && active.kind === TAB_KIND && right.isExpanded?.() === true && right.hide !== undefined) {
      right.hide(active.id)
      return
    }
    right.openTab(TAB_KIND)
  }
  // The panel's own ×: hide the tab when ours is the one on show. A shell
  // without a right Sidebar registers no closer, and the header then omits it.
  const closeBoard = (): void => {
    const right = ctx.sidebarRight as unknown as SidebarRightLoose
    const active = right.active?.()
    if (active !== undefined && active.kind === TAB_KIND && right.hide !== undefined) right.hide(active.id)
  }
  // The Host half is optional: without its Remote the panel still renders, with
  // `origin: 'mock'` shown in the header.
  const remote = optionalService<NonNullable<ClientContext['remote']>>(ctx, 'remote')
  const router = safeGet(() => remote?.router)
  const credentials = safeGet(() => remote?.credentials)
  const setPartitionEnabled = safeGet(() => router?.setPartitionEnabled)
  const createPartition = safeGet(() => router?.createPartition)
  const hostSource: (() => BoardSource) | undefined = router === undefined || remote === undefined
    ? undefined
    : () => createHostSource(router, listener => remote.$on('router/changed', listener))
  const controller = new RouterBoardController(resolveSource(hostSource))

  // Actions beyond reading the board. Each is wired only when the transport
  // behind it exists, so the rail can tell "not configured" from "not
  // implemented": a Remote wins when a Host publishes one; otherwise the Host's
  // HTTP bridge (`/api/router/*`) carries the partition switch.
  const bridgeActions = createHttpActions()
  const host: HostActions = {
    ...(credentials === undefined
      ? {}
      : {
        readCredentials: async (refs: readonly string[]) => {
          const result = await credentials.describe([...refs])
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          return asCredentialViews(refs, result.value)
        },
        writeCredential: async (ref: string, value: string) => {
          const result = await credentials.set(ref, value)
          return result.ok ? undefined : result.error.message
        },
      }),
    ...(setPartitionEnabled === undefined || router === undefined
      ? { setPartitionEnabled: bridgeActions.setPartitionEnabled }
      : {
        setPartitionEnabled: async (partitionId: string, enabled: boolean) => {
          const result = await setPartitionEnabled.call(router, { partitionId, enabled })
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        },
      }),
    ...(createPartition === undefined || router === undefined
      ? {}
      : {
        createPartition: async (name: string) => {
          const result = await createPartition.call(router, { name })
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        },
      }),
  }

  ctx.effect(() => {
    void controller.load()
    return () => { controller.dispose() }
  }, 'client-ui-router: first read')

  /**
   * Props shared by every surface that renders the board.
   *
   * Both the Sidebar tab and the main page mount {@link RouterPanel}, so they must
   * receive the same controller and the same optional services; building the face
   * once is what keeps them from drifting.
   */
  const panelFace = () => {
    const sessions = optionalService<NonNullable<ClientContext['sessions']>>(ctx, 'sessions')
    const uiWorkspace = optionalService<NonNullable<ClientContext['uiWorkspace']>>(ctx, 'uiWorkspace')
    return {
      controller,
      t,
      host,
      ...(sessions === undefined ? {} : { sessions }),
      ...(uiWorkspace === undefined
        ? {}
        : { onOpenSession: (sessionId: string) => { uiWorkspace.openSession(sessionId) } }),
      ...(ctx.sidebarRight.openResource === undefined
        ? {}
        : { onDownload: (artifact: { address: string }) => { ctx.sidebarRight.openResource?.(artifact.address) } }),
    }
  }

  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    locale: NS,
    inject: () => ({ ...panelFace(), onOpenWarRoom: openWarRoom, onClose: closeBoard }),
  }, CompactBoard))

  ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: TAB_ID,
    locale: NS,
    inject: () => ({ controller, t }),
  }, RouterPanelTitle))

  // Entry point: the conversation header. A panel nobody can open ships nothing.
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'router-board',
    order: -8,
    locale: NS,
    inject: () => ({
      t,
      controller,
      open: toggleBoard,
    }),
  }, RouterPanelButton))

  // --- war room ---------------------------------------------------------------

  // The 作战室 is an ordinary Session (the Host's anchor); the main column shows
  // it through the native conversation. The `main` panel below is only the
  // target of the Sidebar row: it opens that Session and gets out of the way.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t, open: openWarRoom }),
  }, WarRoomRedirect))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -40,
    locale: NS,
    label: () => t('warroom.open'),
  }, RoutingIcon))

  // --- workspace ---------------------------------------------------------------

  // 工作区: each partition's files on the left, its rules and open tasks on the
  // right. Reads `/api/router/files` one directory at a time.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: WORKSPACE_ID,
    locale: NS,
    inject: () => {
      const face = panelFace()
      return {
        controller: face.controller,
        t: face.t,
        ...(face.onOpenSession === undefined ? {} : { onOpenSession: face.onOpenSession }),
      }
    },
  }, WorkspacePage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: WORKSPACE_ID,
    order: -39,
    locale: NS,
    label: () => t('ws.open'),
  }, WorkspaceIcon))

  // 「模型档位」: its own footer-action entry (id `model-tiers`), above token stats (-100).
  installModelTierStyles()
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'model-tiers',
    order: -110,
  }, ModelTiers))

  // Land on the 作战室 once per page load. Opening a Session before the
  // Workspace restoration runs makes that restoration stand down, so this
  // decides the first screen and nothing after it.
  ctx.effect(() => {
    let alive = true
    void (async () => {
      for (let attempt = 0; attempt < 20 && alive; attempt++) {
        if (await openAnchor(ctx)) return
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    })()
    return () => { alive = false }
  }, 'client-ui-router: land on war room')
  // --- brand (opt-in) -------------------------------------------------------

  // Both brand slots are `single` and already occupied by the official brand
  // plugin, and the registry throws rather than overwriting. So this is
  // opportunistic: it takes effect only in a profile that disables
  // `ui-brand-official`, and a refusal is silent on purpose — a deployment that
  // has not opted in keeps the shipped brand and still gets the router.
  replaceBrandSlot(ctx, 'sidebar.brand.mark', BrandMark)
  replaceBrandSlot(ctx, 'sidebar.brand.name', BrandName)
}

/** What the slot registry looks like when addressed by a runtime slot name. */
interface LooseSlots {
  inject(name: string, run: () => (() => void) | void): unknown
  register(options: { name: string }, component: unknown): () => void
}

/**
 * Register a component into a single slot, tolerating an occupied one.
 *
 * The typed slot map does not know these two names, and both are declared by
 * another plugin's subtree, so the call is made through a structural view of the
 * registry rather than by widening the shim types.
 * @param ctx - client context.
 * @param name - slot name to fill.
 * @param component - component to render in it.
 */
function replaceBrandSlot(ctx: ClientContext, name: string, component: unknown): void {
  const slots = (ctx as unknown as { slots?: LooseSlots }).slots
  if (slots === undefined) return
  slots.inject(name, () => {
    try {
      return slots.register({ name }, component)
    } catch {
      // Occupied by the official brand plugin: expected, and not an error.
      return () => {}
    }
  })
}
