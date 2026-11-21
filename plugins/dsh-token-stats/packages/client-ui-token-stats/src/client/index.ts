/**
 * Browser entry of `dsh-token-stats`.
 *
 * Contributes exactly one thing: a new entry in the sidebar's
 * `sidebar.footer.action` list slot (rendered above Settings). It registers its
 * own `id` (`token-stats`) so it adds a row instead of replacing anybody, and it
 * does not touch `sidebar.workspaces`, `sidebar.settings` or the right column.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { DICTIONARIES, NS } from './locales.ts'
import type { Translate } from './locales.ts'
import { installStyles } from './styles.ts'
import { TokenStats } from './TokenStats.tsx'
import type { TokenStatsFace } from './TokenStats.tsx'

/** Services this client plugin needs. */
export const inject = ['slots', 'locale']

/** Register the footer block and its dictionaries. */
export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'client-ui-token-stats: dictionaries')
  const t = ctx.locale.bind(NS) as Translate
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'token-stats',
    order: -100,
    locale: NS,
    inject: (): TokenStatsFace => ({ t }),
  }, TokenStats))
}
