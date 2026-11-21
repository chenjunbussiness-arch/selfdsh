/**
 * Left-sidebar block 「模型档位」.
 *
 * Collapsed: a full-width card summarising which model each difficulty tier
 * uses (初级 / 中级 / 高级) and whether automatic tier selection is on.
 * Expanded: a popover anchored above the card with, per tier, a model picker
 * grouped by provider, a reasoning-effort picker (when the model has efforts),
 * and a reset-to-default action, plus the 「自动按难度选择」 switch.
 *
 * Registered as its own `sidebar.footer.action` entry (`id: model-tiers`), so it
 * adds a row and replaces nobody. Reads and writes `GET|POST /api/router/tiers`
 * (host-router bridge). A save applies to the next dispatch; nothing reloads.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Tier = 'easy' | 'medium' | 'hard'
const TIERS: readonly Tier[] = ['easy', 'medium', 'hard']
const LABEL: Record<Tier, string> = { easy: '初级', medium: '中级', hard: '高级' }
const HINT: Record<Tier, string> = {
  easy: '只读小活：列目录、统计、查状态',
  medium: '常规修改：加功能、修小问题',
  hard: '大改动：重构、改版、跨文件排查',
}

interface Route { provider: string; model: string; reasoningEffort?: string }
interface ModelOption { provider: string; providerName: string; model: string; name: string; efforts?: string[] }
interface TierDoc {
  auto: boolean
  saved: Partial<Record<Tier, Route>>
  effective: Record<Tier, Route | null | undefined>
  defaults?: Record<Tier, Route | null | undefined>
  defaultModel?: Route | null
  models: ModelOption[]
}

interface Placement { left: number; bottom: number; width: number; maxHeight: number }

const keyOf = (route: Pick<Route, 'provider' | 'model'> | null | undefined): string =>
  route == null ? '' : `${route.provider}\u0000${route.model}`

/** `kiro/claude-opus-5.5` → `claude-opus-5.5`; display names pass through. */
function shortName(name: string): string {
  const slash = name.lastIndexOf('/')
  return slash >= 0 && slash < name.length - 1 ? name.slice(slash + 1) : name
}

const EFFORT_LABEL: Record<string, string> = {
  off: '关闭', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高',
}

const CSS = `
:where(div):has(> [data-slot] > .dmt-root), :where(div):has(> [data-slot] > .dst-root) {
  flex-wrap: wrap; row-gap: 6px;
}
.dmt-root {
  --dmt-text: var(--dsw-alias-label-primary, #0f1115);
  --dmt-text2: var(--dsw-alias-label-secondary, #61666b);
  --dmt-caption: var(--dsw-alias-label-caption, #81858c);
  --dmt-line: var(--dsw-alias-border-l1, rgba(0,0,0,.06));
  --dmt-line2: var(--dsw-alias-border-l2, rgba(0,0,0,.08));
  --dmt-hover: var(--dsw-alias-interactive-bg-hover, rgba(38,49,72,.06));
  --dmt-accent: var(--dsw-alias-state-business-primary, #4d6bfe);
  --dmt-bad: var(--dsw-alias-state-error-primary, #ec1313);
  --dmt-pop: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1, #ffffff));
  --dmt-easy: #22a06b; --dmt-medium: #e6a23c; --dmt-hard: #8b5cf6;
  position: relative; flex: 1 0 100%; width: 100%; min-width: 0; box-sizing: border-box;
  color: var(--dmt-text); font-family: inherit; text-align: left;
}
.dmt-root *, .dmt-root *::before, .dmt-root *::after { box-sizing: border-box; }
.dmt-card {
  display: flex; flex-direction: column; gap: 6px; width: 100%; min-width: 0;
  padding: 8px 10px; border: 1px solid var(--dmt-line); border-radius: 12px;
  background: transparent; color: var(--dmt-text); font: inherit; font-size: 12px;
  line-height: 1.35; text-align: left; cursor: pointer; transition: background .15s ease;
}
.dmt-card:hover { background: var(--dmt-hover); }
.dmt-card:focus-visible { outline: 2px solid var(--dmt-accent); outline-offset: 1px; }
.dmt-card[aria-expanded="true"] { border-color: color-mix(in srgb, var(--dmt-accent) 38%, var(--dmt-line)); }
.dmt-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.dmt-title { font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--dmt-caption); white-space: nowrap; }
.dmt-badge {
  margin-left: auto; padding: 1px 6px; border-radius: 999px; font-size: 10px; white-space: nowrap;
  color: var(--dmt-caption); background: color-mix(in srgb, var(--dmt-caption) 12%, transparent);
}
.dmt-badge[data-on] { color: var(--dmt-accent); background: color-mix(in srgb, var(--dmt-accent) 12%, transparent); }
.dmt-caret { font-size: 9px; color: var(--dmt-caption); }
.dmt-lines { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dmt-line { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 6px; min-width: 0; }
.dmt-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dmt-caption); }
.dmt-dot[data-tier="easy"] { background: var(--dmt-easy); }
.dmt-dot[data-tier="medium"] { background: var(--dmt-medium); }
.dmt-dot[data-tier="hard"] { background: var(--dmt-hard); }
.dmt-line-label { font-size: 11px; color: var(--dmt-text2); white-space: nowrap; }
.dmt-line-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--dmt-text); text-align: right; }
.dmt-root[data-off] .dmt-line { opacity: .5; }
.dmt-note { font-size: 10px; color: var(--dmt-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmt-note[data-bad] { color: var(--dmt-bad); }

.dmt-pop {
  position: fixed; z-index: 1200; display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--dmt-line2); border-radius: 14px; background: var(--dmt-pop); color: var(--dmt-text);
  box-shadow: 0 18px 48px rgba(15,17,21,.2), 0 2px 8px rgba(15,17,21,.08);
  font-size: 12px; line-height: 1.45; overflow: hidden;
}
.dmt-pop-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 8px; border-bottom: 1px solid var(--dmt-line); flex: none; }
.dmt-pop-title { margin-right: auto; font-size: 12px; font-weight: 600; }
.dmt-close {
  display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: var(--dmt-caption);
  font: inherit; font-size: 15px; line-height: 1; cursor: pointer;
}
.dmt-close:hover { background: var(--dmt-hover); color: var(--dmt-text); }
.dmt-pop-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; padding: 10px 12px 12px; overflow-y: auto; }
.dmt-switch-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border-radius: 10px;
  background: color-mix(in srgb, var(--dmt-accent) 6%, transparent); }
.dmt-switch-text { display: flex; flex-direction: column; gap: 1px; margin-right: auto; min-width: 0; }
.dmt-switch-title { font-size: 12px; font-weight: 600; }
.dmt-switch-hint { font-size: 10.5px; color: var(--dmt-caption); }
.dmt-switch {
  position: relative; flex: none; width: 32px; height: 18px; margin-top: 1px; padding: 0; border: 0; border-radius: 999px;
  background: color-mix(in srgb, var(--dmt-caption) 35%, transparent); cursor: pointer; transition: background .15s ease;
}
.dmt-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s ease;
}
.dmt-switch[aria-checked="true"] { background: var(--dmt-accent); }
.dmt-switch[aria-checked="true"]::after { transform: translateX(14px); }
.dmt-switch:disabled { opacity: .5; cursor: default; }
.dmt-tier { display: flex; flex-direction: column; gap: 5px; padding: 8px 10px; border: 1px solid var(--dmt-line); border-radius: 10px; }
.dmt-root[data-off] ~ .dmt-pop .dmt-tier, .dmt-pop[data-off] .dmt-tier { opacity: .55; }
.dmt-tier-head { display: flex; align-items: center; gap: 6px; }
.dmt-tier-name { font-size: 12px; font-weight: 600; }
.dmt-tier-hint { margin-right: auto; font-size: 10.5px; color: var(--dmt-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.dmt-tag { flex: none; font-size: 10px; color: var(--dmt-caption); }
.dmt-reset {
  flex: none; padding: 1px 6px; border: 1px solid var(--dmt-line2); border-radius: 6px; background: transparent;
  color: var(--dmt-text2); font: inherit; font-size: 10px; cursor: pointer;
}
.dmt-reset:hover { background: var(--dmt-hover); }
.dmt-fields { display: grid; grid-template-columns: minmax(0,1fr) 76px; gap: 6px; }
.dmt-fields[data-single] { grid-template-columns: minmax(0,1fr); }
.dmt-select {
  width: 100%; min-width: 0; height: 26px; padding: 0 6px; font: inherit; font-size: 11.5px;
  border: 1px solid var(--dmt-line2); border-radius: 7px; background: transparent; color: var(--dmt-text);
}
.dmt-select:focus-visible { outline: 2px solid var(--dmt-accent); outline-offset: 0; }
.dmt-select option, .dmt-select optgroup { color: #0f1115; background: #fff; }
.dmt-pop-foot { flex: none; padding: 7px 12px 8px; border-top: 1px solid var(--dmt-line); font-size: 10.5px; color: var(--dmt-caption); }
.dmt-pop-foot[data-bad] { color: var(--dmt-bad); }
@media (prefers-reduced-motion: reduce) { .dmt-card, .dmt-switch, .dmt-switch::after { transition: none; } }
`

/** Install the stylesheet once. */
export function installModelTierStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector('style[data-plugin-css="dsh-model-tiers"]')
  if (existing !== null) { existing.textContent = CSS; return }
  const tag = document.createElement('style')
  tag.dataset.pluginCss = 'dsh-model-tiers'
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/** Popover anchored above `anchor`, recomputed on resize/scroll while open. */
function usePlacement(open: boolean, anchor: React.RefObject<HTMLDivElement | null>): Placement | null {
  const [placement, setPlacement] = useState<Placement | null>(null)
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const box = anchor.current?.getBoundingClientRect()
      if (box === undefined) return
      const width = Math.min(340, Math.max(280, window.innerWidth - 24))
      setPlacement({
        left: Math.min(Math.max(8, box.left), Math.max(8, window.innerWidth - width - 8)),
        bottom: Math.max(8, window.innerHeight - box.top + 6),
        width,
        maxHeight: Math.max(260, Math.min(box.top - 12, 680)),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, anchor])
  return open ? placement : null
}

/** The sidebar block. `wide` is false in the collapsed rail, where it hides. */
export function ModelTiers({ wide = true }: { wide?: boolean }) {
  const [doc, setDoc] = useState<TierDoc | null>(null)
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  const placement = usePlacement(open, rootRef)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/router/tiers', { cache: 'no-store', credentials: 'same-origin' })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      setDoc(await response.json() as TierDoc)
      setMsg(previous => (previous?.bad === true ? null : previous))
    } catch (error) {
      setMsg({ text: `读取失败：${error instanceof Error ? error.message : String(error)}`, bad: true })
    }
  }, [])
  useEffect(() => { void load() }, [load])
  // A confirmation fades back to the footer's standing hint; an error stays put.
  useEffect(() => {
    if (msg === null || msg.bad === true || busy) return
    const timer = setTimeout(() => { setMsg(previous => (previous === msg ? null : previous)) }, 4000)
    return () => { clearTimeout(timer) }
  }, [msg, busy])
  useEffect(() => { if (open) void load() }, [open, load])

  const save = useCallback(async (body: Record<string, unknown>, done: string) => {
    setBusy(true)
    setMsg({ text: '保存中…' })
    try {
      const response = await fetch('/api/router/tiers', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      // A proxy error page is HTML, not JSON: report its status, not a parse error.
      const text = await response.text()
      let value: (TierDoc & { error?: { message: string } }) | undefined
      try { value = JSON.parse(text) as TierDoc & { error?: { message: string } } } catch { value = undefined }
      if (!response.ok || value === undefined) throw new Error(value?.error?.message ?? `HTTP ${String(response.status)}`)
      setDoc(value)
      setMsg({ text: done })
    } catch (error) {
      setMsg({ text: `保存失败：${error instanceof Error ? error.message : String(error)}`, bad: true })
    } finally {
      setBusy(false)
    }
  }, [])

  // Dismiss on outside pointer-down or Escape.
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

  const groups = useMemo(() => {
    const out: { name: string; models: ModelOption[] }[] = []
    for (const model of doc?.models ?? []) {
      const group = out.find(entry => entry.name === model.providerName)
      if (group === undefined) out.push({ name: model.providerName, models: [model] })
      else group.models.push(model)
    }
    return out
  }, [doc])

  const optionOf = (route: Route | null | undefined): ModelOption | undefined =>
    doc?.models.find(entry => keyOf(entry) === keyOf(route))
  const labelOf = (route: Route | null | undefined): string => {
    if (route == null) return '默认模型'
    const option = optionOf(route)
    return shortName(option?.name ?? route.model)
  }

  if (!wide) return null
  const auto = doc?.auto ?? true
  const offAttr = doc !== null && !auto ? { 'data-off': '' } : {}

  return (
    <div className="dmt-root" data-model-tiers="" ref={rootRef} {...offAttr}>
      <button
        type="button"
        className="dmt-card"
        aria-expanded={open}
        aria-label={open ? '收起模型档位设置' : '展开模型档位设置'}
        onClick={() => { setOpen(previous => !previous) }}
      >
        <span className="dmt-head">
          <span className="dmt-title">模型档位</span>
          <span className="dmt-badge" {...auto ? { 'data-on': '' } : {}}>{doc === null ? '…' : auto ? '自动选择' : '已关闭'}</span>
          <span className="dmt-caret" aria-hidden>{open ? '▾' : '▴'}</span>
        </span>
        {doc === null
          ? <span className="dmt-note" {...msg?.bad === true ? { 'data-bad': '' } : {}}>{msg?.text ?? '加载中…'}</span>
          : (
            <span className="dmt-lines">
              {TIERS.map(tier => {
                const route = doc.effective[tier]
                const effort = route?.reasoningEffort
                return (
                  <span className="dmt-line" key={tier} title={route == null ? '' : `${optionOf(route)?.providerName ?? route.provider} · ${route.model}`}>
                    <span className="dmt-dot" data-tier={tier} />
                    <span className="dmt-line-label">{LABEL[tier]}</span>
                    <span className="dmt-line-model">
                      {labelOf(route)}{effort === undefined ? '' : ` · ${EFFORT_LABEL[effort] ?? effort}`}
                    </span>
                  </span>
                )
              })}
            </span>
          )}
      </button>

      {placement === null ? null : (
        <div
          ref={popRef}
          className="dmt-pop"
          role="dialog"
          aria-label="模型档位"
          {...offAttr}
          style={{ left: placement.left, bottom: placement.bottom, width: placement.width, maxHeight: placement.maxHeight }}
        >
          <div className="dmt-pop-head">
            <span className="dmt-pop-title">模型档位</span>
            <button type="button" className="dmt-close" aria-label="关闭" onClick={() => { setOpen(false) }}>×</button>
          </div>
          <div className="dmt-pop-body">
            <div className="dmt-switch-row">
              <span className="dmt-switch-text">
                <span className="dmt-switch-title">自动按难度选择</span>
                <span className="dmt-switch-hint">
                  {auto
                    ? '派任务时先判断难度，再用对应档位的模型'
                    : `已关闭：所有任务使用默认模型 ${labelOf(doc?.defaultModel)}`}
                </span>
              </span>
              <button
                type="button"
                role="switch"
                className="dmt-switch"
                data-tier-auto=""
                aria-checked={auto}
                aria-label="自动按难度选择"
                disabled={doc === null || busy}
                onClick={() => { void save({ auto: !auto }, auto ? '已关闭自动选择' : '已开启自动选择') }}
              />
            </div>

            {doc === null ? <div className="dmt-note">加载中…</div> : TIERS.map(tier => {
              const route = doc.effective[tier]
              const option = optionOf(route)
              const efforts = option?.efforts ?? []
              const saved = doc.saved[tier] !== undefined
              return (
                <div className="dmt-tier" key={tier} data-tier-block={tier}>
                  <div className="dmt-tier-head">
                    <span className="dmt-dot" data-tier={tier} />
                    <span className="dmt-tier-name">{LABEL[tier]}</span>
                    <span className="dmt-tier-hint" title={HINT[tier]}>{HINT[tier]}</span>
                    {saved
                      ? (
                        <button
                          type="button"
                          className="dmt-reset"
                          disabled={busy}
                          onClick={() => { void save({ tiers: { [tier]: null } }, `${LABEL[tier]}已恢复默认`) }}
                        >恢复默认</button>
                      )
                      : <span className="dmt-tag">默认</span>}
                  </div>
                  <div className="dmt-fields" {...efforts.length === 0 ? { 'data-single': '' } : {}}>
                    <select
                      className="dmt-select"
                      data-tier={tier}
                      aria-label={`${LABEL[tier]}模型`}
                      disabled={busy}
                      value={keyOf(route)}
                      onChange={(event) => {
                        const next = doc.models.find(entry => keyOf(entry) === event.currentTarget.value)
                        if (next === undefined) return
                        const keep = route?.reasoningEffort !== undefined && (next.efforts ?? []).includes(route.reasoningEffort)
                        void save({
                          tiers: { [tier]: { provider: next.provider, model: next.model, ...keep ? { reasoningEffort: route?.reasoningEffort } : {} } },
                        }, `${LABEL[tier]}已改为 ${shortName(next.name)}，下一个任务生效`)
                      }}
                    >
                      {option === undefined
                        ? <option value={keyOf(route)}>{route == null ? '（默认模型）' : `${route.model}（不可用）`}</option>
                        : null}
                      {groups.map(group => (
                        <optgroup key={group.name} label={group.name}>
                          {group.models.map(entry => (
                            <option key={keyOf(entry)} value={keyOf(entry)}>{shortName(entry.name)}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {efforts.length === 0 ? null : (
                      <select
                        className="dmt-select"
                        data-tier-effort={tier}
                        aria-label={`${LABEL[tier]}推理强度`}
                        disabled={busy || route == null}
                        value={route?.reasoningEffort ?? ''}
                        onChange={(event) => {
                          if (route == null) return
                          const value = event.currentTarget.value
                          void save({
                            tiers: { [tier]: { provider: route.provider, model: route.model, ...value === '' ? {} : { reasoningEffort: value } } },
                          }, `${LABEL[tier]}推理强度已保存`)
                        }}
                      >
                        <option value="">推理：默认</option>
                        {efforts.map(effort => <option key={effort} value={effort}>{`推理：${EFFORT_LABEL[effort] ?? effort}`}</option>)}
                      </select>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="dmt-pop-foot" {...msg?.bad === true ? { 'data-bad': '' } : {}}>
            {msg?.text ?? '修改立即保存，从下一个派出的任务开始生效'}
          </div>
        </div>
      )}
    </div>
  )
}
