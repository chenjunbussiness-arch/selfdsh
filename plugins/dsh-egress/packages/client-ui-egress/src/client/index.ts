/**
 * Browser entry of the Egress panel.
 *
 * It contributes three things:
 *   1. a main panel (`main` slot, key `egress/panel`) with the exit list, the
 *      binding table and the request log;
 *   2. a Sidebar row that opens it (`sidebar.panellist`);
 *   3. its dictionaries (zh and en).
 *
 * No Harness package is imported as a value: a Client plugin runs inside the Web
 * module loader, where `@deepseek-ai/dsh-*` specifiers are module-table entries,
 * not dependencies. Only types come from the vendored shim. It does not touch
 * `rightbar` (a single slot owned by the right Sidebar).
 */

import { createElement } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { EgressController } from './controller.ts'
import { EgressIcon } from './EgressIcon.tsx'
import { EgressPanel } from './EgressPanel.tsx'
import { DICTIONARIES, NS } from './locales.ts'
import { defaultSources } from './source.ts'
import { installStyles } from './styles.ts'
import type { EgressPanelProps } from './EgressPanel.tsx'

/** Key of the main panel, and the `id` of its Sidebar row (the Sidebar binds a row to the panel with the same key). */
export const PANEL_ID = 'egress/panel'

/** Services this plugin cannot work without. */
export const inject = ['slots', 'locale']

/**
 * Read a service the plugin does not declare in {@link inject}. Cordis 4.1 throws on
 * `ctx.<name>` for an uninjected name, so optional services go through `ctx.get`.
 */
function optionalService<T>(ctx: ClientContext, name: string): T | undefined {
  const get = (ctx as unknown as { get?: (key: string) => unknown }).get
  return typeof get === 'function' ? get.call(ctx, name) as T | undefined : undefined
}

/** Panel wrapper that binds the plugin-wide controller. */
function makePage(controller: EgressController, t: EgressPanelProps['t']) {
  return function EgressPage() {
    return createElement(EgressPanel, { controller, t })
  }
}

/**
 * Register the panel.
 * @param ctx - Client Context carrying slots and locale.
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'client-ui-egress: dictionaries')
  const t = ctx.locale.bind(NS)

  const sources = defaultSources()
  const controller = new EgressController(sources.host, sources.mock)
  ctx.effect(() => controller.start(), 'client-ui-egress: first read and poll')

  const Page = makePage(controller, t)
  const layout = optionalService<{ selectPanel(panelId: string): void }>(ctx, 'layout')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Page))
  void layout // the panel is reached from its Sidebar row; this plugin never steals the landing screen

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -30,
    locale: NS,
    label: () => t('panel.title'),
  }, EgressIcon))
}
