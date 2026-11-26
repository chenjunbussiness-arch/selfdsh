/**
 * Browser entry of `dsh-client-ui-fileshare`.
 *
 * Contributes one `main` panel (the 文件中转 page), one `sidebar.panellist`
 * row that opens it, its dictionaries, and one quiet `POST /api/fileshare/hello`
 * per page load: that tells the host which address this browser uses for DSH,
 * so links an agent creates later carry that address (never an internal one;
 * the host refuses those). Imports no Harness package at runtime.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { FileshareIcon } from './FileshareIcon.tsx'
import { FilesharePage } from './FilesharePage.tsx'
import { DICTIONARIES, NS } from './locales.ts'
import type { Translate } from './locales.ts'
import { hello } from './source.ts'
import { installStyles } from './styles.ts'

export const PANEL_ID = 'fileshare/page'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  installStyles()
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'client-ui-fileshare: dictionaries')
  const t = ctx.locale.bind(NS) as Translate

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => ({ t }),
  }, FilesharePage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: -24,
    locale: NS,
    label: () => t('page.nav'),
  }, FileshareIcon))

  if (typeof window !== 'undefined') {
    window.setTimeout(() => { hello().catch(() => undefined) }, 1500)
  }
}
