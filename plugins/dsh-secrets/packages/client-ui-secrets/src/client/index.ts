/**
 * Browser entry of `dsh-client-ui-secrets`.
 *
 * Contributes, exactly like dsh-client-ui-vpn does for its page: one `main`
 * panel (keyed, so it sits beside `conversation`), one `sidebar.panellist` row
 * that opens it, and its dictionaries. A full page (not the token-stats footer
 * card) because a table with filter and search needs the width. It does not
 * touch `rightbar`, `sidebar.footer.action` or any other plugin's entries, and
 * imports no Harness package at runtime (type-only imports via src/shims).
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { DICTIONARIES, NS } from './locales.ts'
import type { Translate } from './locales.ts'
import { SecretsIcon } from './SecretsIcon.tsx'
import { SecretsPage } from './SecretsPage.tsx'
import { installStyles } from './styles.ts'

/** Key of the main panel, and the `id` of its Sidebar row. */
export const PANEL_ID = 'secrets/page'

/** Services this plugin cannot work without. */
export const inject = ['slots', 'locale']

/**
 * Register the page.
 * @param ctx - Client Context carrying slots and locale.
 */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'client-ui-secrets: dictionaries')
  const t = ctx.locale.bind(NS) as Translate

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t }),
  }, SecretsPage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -25,
    locale: NS,
    label: () => t('page.nav'),
  }, SecretsIcon))
}
