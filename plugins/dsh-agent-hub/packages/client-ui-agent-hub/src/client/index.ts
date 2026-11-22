/**
 * Browser entry of `dsh-agent-hub`'s dispatch panel.
 *
 * Where it shows up:
 *   1. the router board's 「Agent」 tab (primary). The board (`dsh-router-b`) is
 *      another plugin's bundle, so the tab goes through the `globalThis`
 *      registry in `board-tabs.ts` (identical copy in both plugins): id
 *      `agent-hub`, order 100, body = {@link AgentHubPage} in its embedded form.
 *      Its badge counts pending enrollment requests; when there is nothing to
 *      approve but an offline (or left) agent still holds tasks, it shows the
 *      attention dot (`flag`, board-tabs v1 optional field) instead;
 *   2. a `main` panel (keyed, beside `conversation`), kept as a FALLBACK only:
 *      its `sidebar.panellist` row is registered only when, {@link FALLBACK_DELAY_MS}
 *      after this plugin starts, no board has declared itself in the registry
 *      (router-b not installed). The row goes away again as soon as a board
 *      appears, and comes back the same way if the board leaves;
 *   3. its dictionaries.
 *
 * It does not touch `rightbar` or the sidebar footer, and imports no Harness
 * package at runtime (inside the Web module loader `@deepseek-ai/*` specifiers
 * are module-table entries; the shim in src/shims only supplies types).
 *
 * The page is read-only: it only GETs `/api/agent-hub/admin/*`.
 *
 * Why pending requests and not offline agents for the badge: a pending
 * enrollment request is the one thing on this page that waits for a person
 * (approve or reject in the DSH chat), the same "needs you" signal the board's
 * own tabs flag. An offline agent is often a normal state (a laptop asleep, a
 * runner scaled to zero), so counting them would keep a number on the tab most
 * of the time and teach people to ignore it.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { AgentHubPage, createAgentHubBoardTab } from './AgentHubPage.tsx'
import { boardTabs } from './board-tabs.ts'
import type { Overview } from './contract.ts'
import { agentStatus } from './format.ts'
import { HubIcon } from './HubIcon.tsx'
import { DICTIONARIES, NS } from './locales.ts'
import type { Translate } from './locales.ts'
import { fetchOverview } from './source.ts'
import { installStyles } from './styles.ts'

/** Key of the main panel, and the `id` of its (fallback) Sidebar row. */
export const PANEL_ID = 'agent-hub/page'

/** Id of the router board tab (the board addresses it as `ext:agent-hub`). */
export const BOARD_TAB_ID = 'agent-hub'

/** Position after the board's built-in tabs. */
export const BOARD_TAB_ORDER = 100

/** How long a board has to declare itself before the Sidebar row is added. */
export const FALLBACK_DELAY_MS = 3000

/** Badge refresh while the tab body is not mounted (the body refreshes itself). */
export const BADGE_POLL_MS = 30_000

/** Services this plugin cannot work without. */
export const inject = ['slots', 'locale']

/**
 * Register the board tab, the fallback page and its dictionaries.
 * @param ctx - Client Context carrying slots and locale.
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'client-ui-agent-hub: dictionaries')
  const t = ctx.locale.bind(NS) as Translate
  const registry = boardTabs()

  // --- badge + flag ------------------------------------------------------------
  // badge: pending enrollment requests (the one thing here that waits for a person).
  // flag:  only when nothing is pending, an offline / left agent that still holds
  //        tasks. The hub requeues those on its own (worker-offline), so this is a
  //        heads-up dot, not a count. Boards built before `flag` ignore it.
  let pending: number | undefined
  let stranded: { agents: number; tasks: number } | undefined
  let reportedAt = 0
  const report = (overview: Overview): void => {
    reportedAt = Date.now()
    const count = overview.pending_requests
    const nextPending = typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : undefined
    let agents = 0
    let tasks = 0
    for (const agent of Array.isArray(overview.agents) ? overview.agents : []) {
      const status = agentStatus(agent)
      const held = Array.isArray(agent.running_tasks) ? agent.running_tasks.length : 0
      if ((status === 'offline' || status === 'left') && held > 0) {
        agents += 1
        tasks += held
      }
    }
    const nextStranded = agents > 0 ? { agents, tasks } : undefined
    const changed = nextPending !== pending
      || nextStranded?.agents !== stranded?.agents || nextStranded?.tasks !== stranded?.tasks
    pending = nextPending
    stranded = nextStranded
    if (changed) registry.notify()
  }
  const flag = (): string | undefined => (pending === undefined && stranded !== undefined
    ? t('board.flag.stranded', { n: stranded.agents, tasks: stranded.tasks })
    : undefined)

  // --- 1. the router board tab ------------------------------------------------
  ctx.effect(() => registry.register({
    id: BOARD_TAB_ID,
    order: BOARD_TAB_ORDER,
    label: () => t('board.tab'),
    badge: () => pending,
    flag,
    Component: createAgentHubBoardTab(t, report),
  }), 'client-ui-agent-hub: board tab')

  // Keep the badge current while the tab is not open. Only when a board exists,
  // only while the browser tab is visible, and not when the mounted tab body
  // reported a moment ago (it reads the overview every 10 s on its own).
  ctx.effect(() => {
    let alive = true
    const tick = (): void => {
      if (!alive || !registry.hasConsumer()) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (Date.now() - reportedAt < BADGE_POLL_MS / 2) return
      fetchOverview().then((overview) => { if (alive) report(overview) }, () => {
        // Unreachable or logged out: the badge keeps its last value.
      })
    }
    const first = setTimeout(tick, FALLBACK_DELAY_MS)
    const timer = setInterval(tick, BADGE_POLL_MS)
    return () => {
      alive = false
      clearTimeout(first)
      clearInterval(timer)
    }
  }, 'client-ui-agent-hub: board tab badge')

  // --- 2. fallback: own page + Sidebar row when no board is installed ---------
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t }),
  }, AgentHubPage))

  ctx.effect(() => {
    let row: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const install = (): void => {
      timer = undefined
      if (registry.hasConsumer() || row !== undefined) return
      row = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: -25,
        locale: NS,
        label: () => t('page.title'),
      }, HubIcon))
    }
    const sync = (): void => {
      if (registry.hasConsumer()) {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        if (row !== undefined) row()
        row = undefined
        return
      }
      // No board: give one FALLBACK_DELAY_MS to appear (load order, a reload of
      // router-b) before the row is added.
      if (row === undefined && timer === undefined) timer = setTimeout(install, FALLBACK_DELAY_MS)
    }
    const stop = registry.subscribe(sync)
    sync()
    return () => {
      stop()
      if (timer !== undefined) clearTimeout(timer)
      if (row !== undefined) row()
    }
  }, 'client-ui-agent-hub: sidebar fallback')
}
