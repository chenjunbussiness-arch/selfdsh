/**
 * Browser entry of the VPN page.
 *
 * Contributes: one `main` panel (keyed, so it sits beside `conversation`), one
 * Sidebar row that opens it, and its dictionaries. It does NOT touch `rightbar`
 * (a single slot owned by sidebar-right) and imports no Harness package at
 * runtime: inside the Web module loader `@deepseek-ai/*` specifiers are
 * module-table entries, and rc.3 does not ship the slot packages as files.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { VpnController } from './controller.ts'
import { DICTIONARIES, NS } from './locales.ts'
import type { Translate } from './locales.ts'
import { resolveSource } from './source.ts'
import { installStyles } from './styles.ts'
import { VpnIcon } from './VpnIcon.tsx'
import { VpnPage } from './VpnPage.tsx'

/** Key of the main panel, and the `id` of its Sidebar row. */
export const PANEL_ID = 'vpn/page'

/** Services this plugin cannot work without. */
export const inject = ['slots', 'locale']

/**
 * Register the page.
 * @param ctx - Client Context carrying slots and locale.
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'client-ui-vpn: dictionaries')
  const t = ctx.locale.bind(NS) as Translate
  const controller = new VpnController(resolveSource())

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ controller, t }),
  }, VpnPage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -30,
    locale: NS,
    label: () => t('page.title'),
  }, VpnIcon))
}
