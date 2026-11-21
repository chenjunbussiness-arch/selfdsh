/**
 * The sidebar footer block: a full-width card with today's total, its split into
 * fresh input / cache reads / output, the top models and a 7-day mini chart.
 * Clicking it opens a popover with a range switch (今日 / 近 7 天 / 近 30 天),
 * the per-model split for that range, and daily bars stacked by model.
 *
 * It occupies the `sidebar.footer.action` list slot (its own `id`), reads one
 * same-origin JSON document from `dsh-host-token-stats`, and keeps every colour
 * on `--dsw-alias-*` tokens. In the 56 px collapsed rail it degrades to a
 * 40×40 icon button.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { Summary } from './contract.ts'
import { formatPercent, formatTokens, shiftDate, shortDate, shortModel, timeOfDay } from './format.ts'
import type { Translate } from './locales.ts'
import { fetchSummary } from './source.ts'

/** What the plugin injects into the component (besides the slot's owner props). */
export interface TokenStatsFace {
  t: Translate
}

/** Props: the injected face plus `wide` from the sidebar footer-action owner. */
export interface TokenStatsProps extends TokenStatsFace {
  wide?: boolean
}

interface ViewState {
  status: 'loading' | 'ready' | 'error'
  data?: Summary
  error?: string
}

type Range = 1 | 7 | 30

interface Placement { left: number; bottom: number; width: number; maxHeight: number }

interface ModelTotal { model: string; tokens: number; share: number; color: string }

interface DayRow {
  date: string
  billed: number
  today: boolean
  percent: number
  parts: { model: string; percent: number; color: string }[]
}

/** Stable per-model colours (by first appearance in the all-time ranking). */
const PALETTE = ['#4d6bfe', '#22a06b', '#e6a23c', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#64748b']

function useSummary(): { state: ViewState; reload: (force?: boolean) => void } {
  const [state, setState] = useState<ViewState>({ status: 'loading' })
  const ticket = useRef(0)
  const load = useCallback((force = false) => {
    const mine = ticket.current + 1
    ticket.current = mine
    fetchSummary(force).then(
      data => { if (mine === ticket.current) setState({ status: 'ready', data }) },
      (error: unknown) => {
        if (mine !== ticket.current) return
        const message = error instanceof Error ? error.message : String(error)
        setState(previous => previous.data === undefined ? { status: 'error', error: message } : { status: 'ready', data: previous.data })
      },
    )
  }, [])
  useEffect(() => {
    load(false)
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') load(false) }, 20_000)
    const onVisibility = (): void => { if (document.visibilityState !== 'hidden') load(false) }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      ticket.current += 1
    }
  }, [load])
  return { state, reload: load }
}

function colorMap(data: Summary | undefined): Map<string, string> {
  const map = new Map<string, string>()
  const ranked = [...(data?.models ?? [])].sort((a, b) => b.total - a.total)
  ranked.forEach((model, index) => { map.set(model.model, PALETTE[index % PALETTE.length] ?? '#64748b') })
  return map
}

/** Per-model totals over the last `range` days (1 = today only). */
function modelTotalsOf(data: Summary, range: Range, colors: Map<string, string>): { total: number; models: ModelTotal[] } {
  const first = shiftDate(data.today.date, -(range - 1))
  const sums = new Map<string, number>()
  for (const day of data.days) {
    if (day.date < first || day.date > data.today.date) continue
    for (const [model, tokens] of Object.entries(day.models)) sums.set(model, (sums.get(model) ?? 0) + tokens)
  }
  const total = [...sums.values()].reduce((sum, value) => sum + value, 0)
  const models = [...sums.entries()]
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([model, tokens]) => ({ model, tokens, share: total > 0 ? tokens / total : 0, color: colors.get(model) ?? '#64748b' }))
  return { total, models }
}

/** The last `range` calendar days, zero-filled, each bar stacked by model. */
function dayRowsOf(data: Summary, range: number, colors: Map<string, string>): DayRow[] {
  const byDate = new Map(data.days.map(day => [day.date, day]))
  const raw = []
  for (let offset = range - 1; offset >= 0; offset -= 1) {
    const date = shiftDate(data.today.date, -offset)
    raw.push({ date, day: byDate.get(date), today: offset === 0 })
  }
  const max = raw.reduce((highest, row) => Math.max(highest, row.day?.billed ?? 0), 0)
  return raw.map(({ date, day, today }) => {
    const billed = day?.billed ?? 0
    const percent = max > 0 && billed > 0 ? Math.max(2, (billed / max) * 100) : 0
    const parts = Object.entries(day?.models ?? {})
      .filter(([, tokens]) => tokens > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([model, tokens]) => ({ model, percent: billed > 0 ? (tokens / billed) * 100 : 0, color: colors.get(model) ?? '#64748b' }))
    return { date, billed, today, percent, parts }
  })
}

function width(share: number): string {
  return `${Math.max(2, Math.round(share * 100))}%`
}

/**
 * Render the sidebar footer block.
 * @param props - injected `t` and the slot owner's `wide`.
 */
export function TokenStats({ wide = true, t }: TokenStatsProps) {
  const [open, setOpen] = useState(false)
  const [range, setRange] = useState<Range>(1)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const { state, reload } = useSummary()
  const data = state.data
  const colors = useMemo(() => colorMap(data), [data])
  const todaySplit = useMemo(() => (data === undefined ? undefined : modelTotalsOf(data, 1, colors)), [data, colors])
  const rangeSplit = useMemo(() => (data === undefined ? undefined : modelTotalsOf(data, range, colors)), [data, range, colors])
  const week = useMemo(() => (data === undefined ? [] : dayRowsOf(data, 7, colors)), [data, colors])
  const dayRows = useMemo(() => (data === undefined ? [] : dayRowsOf(data, range === 1 ? 7 : range, colors)), [data, range, colors])
  const totalText = data === undefined ? '—' : formatTokens(data.today.billed)

  const toggle = useCallback(() => { setOpen(previous => !previous) }, [])

  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const anchor = rootRef.current?.getBoundingClientRect()
      if (anchor === undefined) return
      const w = Math.min(340, Math.max(280, window.innerWidth - 24))
      setPlacement({
        left: Math.min(Math.max(8, anchor.left), Math.max(8, window.innerWidth - w - 8)),
        bottom: Math.max(8, window.innerHeight - anchor.top + 6),
        width: w,
        maxHeight: Math.max(260, Math.min(anchor.top - 12, 680)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (rootRef.current?.contains(target) === true || popRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const todayModels = todaySplit?.models ?? []
  const card = wide ? (
    <button
      type="button"
      className="dst-card"
      onClick={toggle}
      aria-expanded={open}
      aria-label={open ? t('aria.close') : t('aria.open')}
    >
      <span className="dst-head">
        <span className="dst-title">{t('title')}</span>
        <span className="dst-caret" aria-hidden>{open ? '▾' : '▴'}</span>
      </span>
      {state.status === 'error' && data === undefined
        ? <span className="dst-note" data-bad="">{t('error.short')}</span>
        : data === undefined
          ? <span className="dst-note">{t('loading')}</span>
          : (
            <>
              <span className="dst-big-row">
                <span className="dst-big">{totalText}</span>
                <span className="dst-big-label">{t('today.short')}</span>
                <span className="dst-spark" aria-hidden title={t('spark.title')}>
                  {week.map(row => (
                    <i key={row.date} data-today={row.today ? 'true' : undefined} style={{ height: `${Math.max(row.percent, row.billed > 0 ? 8 : 4)}%` }} />
                  ))}
                </span>
              </span>
              <span className="dst-split">
                <span><b>{formatTokens(data.today.uncachedInput)}</b> {t('split.input')}</span>
                <span><b>{formatTokens(data.today.cacheRead)}</b> {t('split.cache')}</span>
                <span><b>{formatTokens(data.today.output)}</b> {t('split.output')}</span>
              </span>
              {todayModels.length === 0
                ? <span className="dst-note">{t('empty.short')}</span>
                : (
                  <span className="dst-stack" aria-hidden>
                    {todayModels.map(model => <i key={model.model} style={{ width: width(model.share), background: model.color }} />)}
                  </span>
                )}
              {todayModels.slice(0, 3).map(model => (
                <span className="dst-model" key={model.model} title={model.model}>
                  <span className="dst-swatch" style={{ background: model.color }} />
                  <span className="dst-model-name">{shortModel(model.model)}</span>
                  <span className="dst-model-tok">{formatTokens(model.tokens)}</span>
                  <span className="dst-model-share">{formatPercent(model.share)}</span>
                </span>
              ))}
            </>
          )}
    </button>
  ) : (
    <button
      type="button"
      className="dst-rail"
      onClick={toggle}
      aria-expanded={open}
      aria-label={open ? t('aria.close') : t('aria.open')}
      title={`${t('title')} · ${totalText}`}
    >
      <span className="dst-rail-bars" aria-hidden>
        {(week.length > 0 ? week.slice(-4) : [40, 72, 56, 100].map(h => ({ date: String(h), percent: h }))).map(row => (
          <i key={row.date} style={{ height: `${Math.max(12, row.percent)}%` }} />
        ))}
      </span>
    </button>
  )

  const rangeTitle = range === 1 ? t('range.today') : range === 7 ? t('range.7') : t('range.30')
  const body = data !== undefined && data.totals.billed > 0 && rangeSplit !== undefined
    ? (
      <>
        <div className="dst-tabs" role="tablist">
          {([1, 7, 30] as const).map(value => (
            <button
              key={value}
              type="button"
              role="tab"
              className="dst-tab"
              aria-selected={range === value}
              data-on={range === value}
              onClick={() => { setRange(value) }}
            >
              {value === 1 ? t('range.today') : value === 7 ? t('range.7') : t('range.30')}
            </button>
          ))}
        </div>
        <div className="dst-hero">
          <span className="dst-hero-value">{formatTokens(rangeSplit.total)}<span className="dst-hero-unit">tokens</span></span>
          <span className="dst-hero-note">{t('hero.note', { range: rangeTitle, time: timeOfDay(data.generatedAt) })}</span>
        </div>
        {range === 1 ? (
          <div className="dst-cells">
            <div className="dst-cell"><span>{t('split.input')}</span><b>{formatTokens(data.today.uncachedInput)}</b></div>
            <div className="dst-cell"><span>{t('split.cache')}</span><b>{formatTokens(data.today.cacheRead)}</b></div>
            <div className="dst-cell"><span>{t('split.output')}</span><b>{formatTokens(data.today.output)}</b></div>
            <div className="dst-cell"><span>{t('split.calls')}</span><b>{data.today.events}</b></div>
          </div>
        ) : null}
        <div className="dst-section">
          <div className="dst-section-title">{t('models.title')}</div>
          {rangeSplit.models.length === 0
            ? <div className="dst-empty-hint">{t('empty.range')}</div>
            : rangeSplit.models.map(model => (
              <div className="dst-model-row" key={model.model}>
                <div className="dst-model-row-head">
                  <span className="dst-swatch" style={{ background: model.color }} />
                  <span className="dst-model-name" title={model.model}>{model.model}</span>
                  <span className="dst-model-tok">{formatTokens(model.tokens)}</span>
                  <span className="dst-model-share">{formatPercent(model.share)}</span>
                </div>
                <span className="dst-track"><span className="dst-fill" style={{ width: width(model.share), background: model.color }} /></span>
              </div>
            ))}
        </div>
        <div className="dst-section">
          <div className="dst-section-title">{range === 30 ? t('daily.title30') : t('daily.title7')}</div>
          <div className="dst-days">
            {dayRows.map(row => (
              <div key={row.date} className="dst-day" data-today={row.today ? 'true' : undefined} data-zero={row.billed === 0 ? 'true' : undefined}>
                <span className="dst-day-date">{shortDate(row.date)}</span>
                <span className="dst-day-track">
                  <span className="dst-day-bar" style={{ width: `${row.percent}%` }}>
                    {row.parts.map(part => <i key={part.model} title={part.model} style={{ width: `${part.percent}%`, background: part.color }} />)}
                  </span>
                </span>
                <span className="dst-day-tok">{row.billed > 0 ? formatTokens(row.billed) : t('value.none')}</span>
              </div>
            ))}
          </div>
        </div>
      </>
    )
    : state.status === 'error' && data === undefined
      ? (
        <div className="dst-error">
          <span className="dst-error-title">{t('error.title')}</span>
          <span className="dst-error-hint">{t('error.hint')}{state.error === undefined ? '' : ` (${state.error})`}</span>
          <button type="button" className="dst-retry" onClick={() => reload(true)}>{t('retry')}</button>
        </div>
      )
      : data === undefined
        ? <div className="dst-empty"><span className="dst-empty-hint">{t('loading')}</span></div>
        : (
          <div className="dst-empty">
            <span className="dst-empty-title">{t('empty.title')}</span>
            <span className="dst-empty-hint">{t('empty.hint')}</span>
          </div>
        )

  const footer = data === undefined ? null : (
    <div className="dst-pop-foot">
      <span className="dst-foot-line">{t('foot.scope')}</span>
      <span className="dst-foot-line">{t('foot.updated', { time: timeOfDay(data.generatedAt), files: data.source.sessionFiles, events: data.source.usageEvents })}</span>
      <button type="button" className="dst-refresh" onClick={() => reload(true)}>{t('refresh')}</button>
    </div>
  )

  return (
    <div className="dst-root" ref={rootRef}>
      {card}
      {open && placement !== null
        ? (
          <div
            ref={popRef}
            className="dst-pop"
            role="dialog"
            aria-label={t('title')}
            style={{ left: placement.left, bottom: placement.bottom, width: placement.width, maxHeight: placement.maxHeight }}
          >
            <div className="dst-pop-head">
              <span className="dst-pop-title">{t('title')}</span>
              <span className="dst-pop-sub">{data?.today.date ?? ''}</span>
              <button type="button" className="dst-close" onClick={() => setOpen(false)} aria-label={t('close')}>×</button>
            </div>
            <div className="dst-pop-body">{body}</div>
            {footer}
          </div>
        )
        : null}
    </div>
  )
}
