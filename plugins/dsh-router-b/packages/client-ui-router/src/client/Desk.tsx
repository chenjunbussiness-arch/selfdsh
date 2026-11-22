/**
 * The desk: what the board needs beyond rows.
 *
 * - {@link ApprovalsSection} — 等你确认: outlet actions (merge a PR, a dangerous
 *   server command, a push or a page capture in confirm mode) the router will
 *   not run until a person says 同意. Each card says what, on what, why, and
 *   whether it can be undone; 同意 runs it once, 拒绝 tells the agent not to.
 * - {@link LivePanel} — a worker's output as it happens, one block per command,
 *   errors in red, with 停止 / 改派 / 换模型 at hand. Polls every 2 s while open
 *   and follows the bottom unless the person scrolled up to read.
 * - {@link ReassignDialog} — 改派 / 换模型: another partition and/or model, and
 *   接着做 (hand over what the old worker did) or 从头来.
 * - {@link BatchBar} — 批量: filter by state, partition and failure cause,
 *   select, act on all of them after one confirmation, then read the outcome.
 *
 * @module client-ui-router/desk
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ApprovalView, BatchAction, BatchResultView, LiveSegmentView, ModelChoiceView, PartitionView, TaskView,
} from './contract.ts'
import type { RouterBoardController } from './controller.ts'
import { clockTime } from './format.ts'

type T = (key: string, values?: Record<string, string | number>) => string

// ---------------------------------------------------------------------------
// failure causes
// ---------------------------------------------------------------------------

/**
 * A failure's cause with the noise taken out, so the same problem on ten rows
 * groups as one: first line only, paths, numbers, hashes and quoted values
 * replaced, whitespace folded, capped at 80 characters.
 */
export function failureKey(error: string | undefined): string {
  if (error === undefined || error.trim() === '') return ''
  const first = error.trim().split('\n')[0]!
  return first
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+){2,}[\\/]?/g, '<path>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<id>')
    .replace(/\b(task|T)-[\w-]+/g, '<task>')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

// ---------------------------------------------------------------------------
// 等你确认
// ---------------------------------------------------------------------------

const KIND_KEY: Readonly<Record<ApprovalView['kind'], string>> = {
  merge: 'ap.kind.merge', ops: 'ap.kind.ops', git: 'ap.kind.git', browser: 'ap.kind.browser',
}

/** Polls the approval queue and renders pending cards; nothing when empty. */
export function ApprovalsSection({ controller, t, titleOf, nameOf, refreshKey }: {
  readonly controller: RouterBoardController
  readonly t: T
  readonly titleOf: ReadonlyMap<string, string>
  readonly nameOf: ReadonlyMap<string, string>
  /** Changes when the board changes, to re-read at once. */
  readonly refreshKey: string
}) {
  const [pending, setPending] = useState<readonly ApprovalView[]>([])
  const [armed, setArmed] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [last, setLast] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  const read = async (): Promise<void> => {
    try {
      const out = await controller.readApprovals()
      setPending(out.pending)
    } catch {
      // Keep the last list; the next tick tries again.
    }
  }

  useEffect(() => {
    if (!controller.canApprove) return
    void read()
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void read()
    }, 5000)
    return () => { clearInterval(timer) }
  }, [controller, refreshKey])

  useEffect(() => {
    if (armed === null) return
    const timer = setTimeout(() => { setArmed(null) }, 5000)
    return () => { clearTimeout(timer) }
  }, [armed])

  useEffect(() => {
    if (last === null) return
    const timer = setTimeout(() => { setLast(null) }, 6000)
    return () => { clearTimeout(timer) }
  }, [last])

  if (!controller.canApprove || (pending.length === 0 && last === null)) return null

  const decide = async (item: ApprovalView, decision: 'approve' | 'reject'): Promise<void> => {
    setBusy(item.id)
    try {
      const out = await controller.decideApproval(item.id, decision, decision === 'reject' ? note.trim() : undefined)
      setLast(out.state === 'failed'
        ? { tone: 'bad', text: t('ap.failed', { result: out.result ?? '' }) }
        : { tone: 'ok', text: decision === 'approve' ? t('ap.ran', { action: item.action }) : t('ap.rejected', { action: item.action }) })
      setPending(previous => previous.filter(entry => entry.id !== item.id))
    } catch (error) {
      setLast({ tone: 'bad', text: t('ap.error', { message: error instanceof Error ? error.message : String(error) }) })
    } finally {
      setBusy(null)
      setArmed(null)
      setRejecting(null)
      setNote('')
    }
  }

  return (
    <section className="dshd-ap" data-approvals aria-label={t('ap.title')}>
      {pending.length > 0 && (
        <div className="dshd-cap">
          <span className="dshd-cap-dot" aria-hidden="true" />
          {t('ap.title')}
          <span className="dshd-cap-n">{pending.length}</span>
        </div>
      )}
      {last !== null && <div className="dshd-flash" data-tone={last.tone} role="status">{last.text}</div>}
      {pending.map((item) => {
        const link = /^https?:\/\//.test(item.target)
        const task = item.taskId === undefined ? undefined : titleOf.get(item.taskId)
        const approveArmed = armed === item.id
        return (
          <article key={item.id} className="dshd-card" data-approval={item.id} data-kind={item.kind}>
            <header className="dshd-card-top">
              <span className="dshd-kind" data-kind={item.kind}>{t(KIND_KEY[item.kind])}</span>
              <span className="dshd-rev" data-rev={item.reversible ? 'yes' : 'no'}>
                {item.reversible ? t('ap.reversible') : t('ap.irreversible')}
              </span>
              <span className="dshd-when" title={item.createdAt}>{clockTime(item.createdAt)}</span>
            </header>
            <h3 className="dshd-card-title">{item.action}</h3>
            {link
              ? <a className="dshd-target" href={item.target} target="_blank" rel="noreferrer noopener">{item.target}</a>
              : <code className="dshd-target">{item.target}</code>}
            {item.reason.trim() !== '' && <p className="dshd-reason">{item.reason}</p>}
            <p className="dshd-from">
              {nameOf.get(item.partition) ?? item.partition}
              {task !== undefined && <> · {task}</>}
            </p>
            {rejecting === item.id
              ? (
                  <form className="dshd-reject" onSubmit={(event) => { event.preventDefault(); void decide(item, 'reject') }}>
                    <input value={note} autoFocus placeholder={t('ap.notePh')} aria-label={t('ap.notePh')}
                      onChange={(event) => { setNote(event.target.value) }} />
                    <button type="button" className="dshd-btn" onClick={() => { setRejecting(null); setNote('') }}>{t('ap.back')}</button>
                    <button type="submit" className="dshd-btn" data-tone="bad" disabled={busy === item.id}>{t('ap.confirmReject')}</button>
                  </form>
                )
              : (
                  <div className="dshd-card-btns">
                    <button type="button" className="dshd-btn" disabled={busy !== null}
                      onClick={() => { setRejecting(item.id); setArmed(null) }}>{t('ap.reject')}</button>
                    <button type="button" className="dshd-btn" data-tone="primary" data-armed={approveArmed ? '' : undefined}
                      disabled={busy !== null}
                      title={item.reversible ? undefined : t('ap.twoStep')}
                      onClick={() => {
                        if (!item.reversible && !approveArmed) { setArmed(item.id); return }
                        void decide(item, 'approve')
                      }}>
                      {busy === item.id ? t('ap.running') : approveArmed ? t('ap.confirmApprove') : t('ap.approve')}
                    </button>
                  </div>
                )}
          </article>
        )
      })}
    </section>
  )
}

// ---------------------------------------------------------------------------
// 实时输出
// ---------------------------------------------------------------------------

/** Merge a newer read into what is shown: same seq replaces, new seq appends. */
export function mergeSegments(shown: readonly LiveSegmentView[], fresh: readonly LiveSegmentView[]): LiveSegmentView[] {
  const bySeq = new Map(shown.map(segment => [segment.seq, segment]))
  for (const segment of fresh) bySeq.set(segment.seq, segment)
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq).slice(-200)
}

const LIVE_STATES = new Set(['queued', 'dispatched', 'running', 'reported', 'verified', 'failed', 'rejected', 'cancelled', 'blocked', 'suspended'])

/** A worker's output, live. */
export function LivePanel({ controller, t, task, onClose, onStop, onReassign }: {
  readonly controller: RouterBoardController
  readonly t: T
  readonly task: TaskView
  readonly onClose: () => void
  readonly onStop?: () => void
  readonly onReassign?: (focus: 'partition' | 'model') => void
}) {
  const [segments, setSegments] = useState<readonly LiveSegmentView[]>([])
  const [state, setState] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [stick, setStick] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [armStop, setArmStop] = useState(false)
  const box = useRef<HTMLDivElement | null>(null)
  const lastSeq = useRef(-1)

  useEffect(() => {
    let stopped = false
    const tick = async (): Promise<void> => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      try {
        const out = await controller.readLive(task.id, lastSeq.current)
        if (stopped) return
        setState(out.state)
        setError(null)
        if (out.segments.length > 0) {
          setSegments((previous) => {
            const next = mergeSegments(previous, out.segments)
            const added = next.filter(segment => segment.seq > lastSeq.current && segment.running !== true).length
            if (added > 0) setUnseen(count => count + added)
            return next
          })
          const settled = out.segments.filter(segment => segment.running !== true)
          if (settled.length > 0) lastSeq.current = Math.max(lastSeq.current, ...settled.map(segment => segment.seq))
        }
      } catch (failure) {
        if (!stopped) setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 2000)
    return () => { stopped = true; clearInterval(timer) }
  }, [controller, task.id])

  // Follow the bottom while the person is there.
  useEffect(() => {
    const element = box.current
    if (element === null) return
    if (stick) {
      element.scrollTop = element.scrollHeight
      setUnseen(0)
    }
  }, [segments, stick])

  const onScroll = (): void => {
    const element = box.current
    if (element === null) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24
    setStick(atBottom)
    if (atBottom) setUnseen(0)
  }

  useEffect(() => {
    if (!armStop) return
    const timer = setTimeout(() => { setArmStop(false) }, 5000)
    return () => { clearTimeout(timer) }
  }, [armStop])

  const errors = segments.filter(segment => segment.error).length
  const shown = onlyErrors ? segments.filter(segment => segment.error) : segments
  const running = state === 'running' || state === 'dispatched'

  return (
    <div className="dshd-live" data-live={task.id} onClick={(event) => { event.stopPropagation() }}>
      <div className="dshd-live-head">
        <span className="dshd-live-dot" data-on={running ? '' : undefined} aria-hidden="true" />
        <span className="dshd-live-title">{t('live.title')}</span>
        <span className="dshd-live-state">{state === '' ? t('live.loading') : LIVE_STATES.has(state) ? t(`live.state.${state}`) : state}</span>
        {errors > 0 && (
          <button type="button" className="dshd-pill" data-tone="bad" aria-pressed={onlyErrors}
            onClick={() => { setOnlyErrors(value => !value) }}>
            {onlyErrors ? t('live.allLines') : t('live.errors', { n: errors })}
          </button>
        )}
        <span className="dshd-grow" />
        <button type="button" className="dshd-x" aria-label={t('live.close')} title={t('live.close')} onClick={onClose}>
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </div>
      <div className="dshd-live-acts">
        {onStop !== undefined && running && (
          <button type="button" className="dshd-btn" data-tone="bad" data-armed={armStop ? '' : undefined}
            onClick={() => {
              if (!armStop) { setArmStop(true); return }
              setArmStop(false)
              onStop()
            }}>
            {armStop ? t('act.confirmStop') : t('act.cancel')}
          </button>
        )}
        {onReassign !== undefined && <button type="button" className="dshd-btn" onClick={() => { onReassign('partition') }}>{t('ra.reassign')}</button>}
        {onReassign !== undefined && <button type="button" className="dshd-btn" onClick={() => { onReassign('model') }}>{t('ra.model')}</button>}
      </div>
      <div className="dshd-live-body" ref={box} onScroll={onScroll} role="log" aria-live="polite">
        {error !== null && <div className="dshd-flash" data-tone="bad">{t('live.error', { message: error })}</div>}
        {shown.length === 0 && error === null && <div className="dshd-live-empty">{state === '' ? t('live.loading') : t('live.empty')}</div>}
        {shown.map(segment => (
          <div key={segment.seq} className="dshd-seg" data-kind={segment.kind} data-error={segment.error ? '' : undefined}
            data-running={segment.running === true ? '' : undefined}>
            <div className="dshd-seg-head">
              {segment.kind === 'command' && <span className="dshd-seg-prompt" aria-hidden="true">$</span>}
              <span className="dshd-seg-title">{segment.kind === 'message' ? t('live.says') : segment.kind === 'end' ? t('live.end', { reason: segment.title }) : segment.title}</span>
              {segment.error && <span className="dshd-seg-tag">{t('live.failed')}</span>}
              {segment.running === true && <span className="dshd-seg-spin" aria-label={t('live.running')} />}
              <span className="dshd-seg-time">{clockTime(new Date(segment.at).toISOString())}</span>
            </div>
            {segment.body !== '' && <pre className="dshd-seg-body">{segment.body}</pre>}
          </div>
        ))}
      </div>
      {!stick && unseen > 0 && (
        <button type="button" className="dshd-jump" onClick={() => { setStick(true) }}>{t('live.jump', { n: unseen })}</button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 改派 / 换模型
// ---------------------------------------------------------------------------

/** Move a task to another partition and/or model. */
export function ReassignDialog({ controller, t, task, partitions, focus, onClose, onDone }: {
  readonly controller: RouterBoardController
  readonly t: T
  readonly task: TaskView
  readonly partitions: readonly PartitionView[]
  readonly focus: 'partition' | 'model'
  readonly onClose: () => void
  readonly onDone: (text: string) => void
}) {
  const [partition, setPartition] = useState(task.partitionId)
  const [models, setModels] = useState<readonly ModelChoiceView[]>([])
  const [model, setModel] = useState('')
  const [keep, setKeep] = useState(true)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    void controller.listModels().then((list) => { if (live) setModels(list) }).catch(() => {})
    return () => { live = false }
  }, [controller])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  const groups = useMemo(() => {
    const out = new Map<string, ModelChoiceView[]>()
    for (const entry of models) out.set(entry.providerName, [...out.get(entry.providerName) ?? [], entry])
    return [...out]
  }, [models])

  const chosen = models.find(entry => `${entry.provider}\u0000${entry.model}` === model)
  const same = partition === task.partitionId && chosen === undefined
  const submit = async (): Promise<void> => {
    if (same && !keep) { setError(t('ra.nothing')); return }
    setBusy(true)
    setError('')
    try {
      const out = await controller.reassign({
        taskId: task.id,
        ...(partition === task.partitionId ? {} : { partition }),
        ...(chosen === undefined ? {} : { model: { provider: chosen.provider, model: chosen.model } }),
        keepProgress: keep,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      })
      onDone(t('ra.done', { from: out.from, to: out.to, partition: out.partition }))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  return (
    <div className="dshd-scrim" onClick={onClose}>
      <form className="dshd-dialog" role="dialog" aria-modal="true" aria-label={t('ra.title')}
        onClick={(event) => { event.stopPropagation() }}
        onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <h3 className="dshd-dialog-title">{focus === 'model' ? t('ra.titleModel') : t('ra.title')}</h3>
        <p className="dshd-dialog-sub">{task.title}</p>
        {task.error !== undefined && task.error !== '' && (
          <p className="dshd-dialog-why"><span>{t('ra.lastError')}</span>{task.error}</p>
        )}
        <label className="dshd-field">
          <span>{t('ra.partition')}</span>
          <select value={partition} autoFocus={focus === 'partition'} onChange={(event) => { setPartition(event.target.value) }}>
            {partitions.map(entry => (
              <option key={entry.id} value={entry.id}>{entry.name}{entry.id === task.partitionId ? ` ${t('ra.current')}` : ''}</option>
            ))}
          </select>
        </label>
        <label className="dshd-field">
          <span>{t('ra.modelLabel')}</span>
          <select value={model} autoFocus={focus === 'model'} onChange={(event) => { setModel(event.target.value) }}>
            <option value="">{t('ra.keepModel')}{task.model === undefined ? '' : `（${task.model}）`}</option>
            {groups.map(([name, list]) => (
              <optgroup key={name} label={name}>
                {list.map(entry => <option key={entry.model} value={`${entry.provider}\u0000${entry.model}`}>{entry.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <fieldset className="dshd-choice">
          <legend>{t('ra.how')}</legend>
          <label data-on={keep ? '' : undefined}>
            <input type="radio" name="keep" checked={keep} onChange={() => { setKeep(true) }} />
            <span><b>{t('ra.keep')}</b><small>{t('ra.keepHint')}</small></span>
          </label>
          <label data-on={!keep ? '' : undefined}>
            <input type="radio" name="keep" checked={!keep} onChange={() => { setKeep(false) }} />
            <span><b>{t('ra.fresh')}</b><small>{t('ra.freshHint')}</small></span>
          </label>
        </fieldset>
        <label className="dshd-field">
          <span>{t('ra.note')}</span>
          <input value={note} placeholder={t('ra.notePh')} onChange={(event) => { setNote(event.target.value) }} />
        </label>
        {error !== '' && <p className="dshd-dialog-err" role="alert">{error}</p>}
        <div className="dshd-dialog-btns">
          <button type="button" className="dshd-btn" onClick={onClose}>{t('ra.cancel')}</button>
          <button type="submit" className="dshd-btn" data-tone="primary" disabled={busy}>{busy ? t('ra.busy') : t('ra.submit')}</button>
        </div>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 批量
// ---------------------------------------------------------------------------

/** Filters of batch mode; empty string means any. */
export interface BatchFilter {
  readonly group: string
  readonly partition: string
  readonly failure: string
}

export const NO_FILTER: BatchFilter = { group: '', partition: '', failure: '' }

const BATCH_ACTIONS: readonly BatchAction[] = ['cancel', 'retry', 'suspend', 'resume', 'reassign']

/** The batch bar: filters, selection, one action with a confirmation, and the outcome. */
export function BatchBar({ controller, t, filter, setFilter, groups, partitions, failures, visibleIds, selected, setSelected, titleOf, onExit }: {
  readonly controller: RouterBoardController
  readonly t: T
  readonly filter: BatchFilter
  readonly setFilter: (filter: BatchFilter) => void
  /** Groups present on the board, with counts, already translated. */
  readonly groups: readonly { readonly id: string; readonly label: string; readonly n: number }[]
  readonly partitions: readonly PartitionView[]
  /** Failure causes and how many rows share each. */
  readonly failures: readonly { readonly key: string; readonly n: number }[]
  /** Task ids on screen under the current filters. */
  readonly visibleIds: readonly string[]
  readonly selected: ReadonlySet<string>
  readonly setSelected: (next: ReadonlySet<string>) => void
  readonly titleOf: ReadonlyMap<string, string>
  readonly onExit: () => void
}) {
  const [action, setAction] = useState<BatchAction | null>(null)
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BatchResultView | null>(null)
  const [error, setError] = useState('')

  const allOn = visibleIds.length > 0 && visibleIds.every(id => selected.has(id))
  const run = async (): Promise<void> => {
    if (action === null) return
    setBusy(true)
    setError('')
    try {
      const out = await controller.batch([...selected], action, action === 'reassign' ? (target === '' ? undefined : target) : undefined)
      setResult(out)
      setSelected(new Set(out.results.filter(row => !row.ok).map(row => row.id)))
      setAction(null)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="dshd-batch" data-batch aria-label={t('batch.title')}>
      <div className="dshd-batch-filters">
        <select aria-label={t('batch.byState')} value={filter.group} onChange={(event) => { setFilter({ ...filter, group: event.target.value }) }}>
          <option value="">{t('batch.anyState')}</option>
          {groups.map(entry => <option key={entry.id} value={entry.id}>{entry.label}（{entry.n}）</option>)}
        </select>
        <select aria-label={t('batch.byPartition')} value={filter.partition} onChange={(event) => { setFilter({ ...filter, partition: event.target.value }) }}>
          <option value="">{t('batch.anyPartition')}</option>
          {partitions.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        <select aria-label={t('batch.byFailure')} value={filter.failure} disabled={failures.length === 0}
          onChange={(event) => { setFilter({ ...filter, failure: event.target.value }) }}>
          <option value="">{failures.length === 0 ? t('batch.noFailures') : t('batch.anyFailure')}</option>
          {failures.map(entry => <option key={entry.key} value={entry.key}>{entry.key}（{entry.n}）</option>)}
        </select>
      </div>
      {failures.length > 1 && filter.failure === '' && (
        <div className="dshd-causes" aria-label={t('batch.causes')}>
          {failures.slice(0, 4).map(entry => (
            <button key={entry.key} type="button" className="dshd-cause" title={entry.key}
              onClick={() => { setFilter({ ...filter, failure: entry.key }) }}>
              <span className="dshd-cause-n">{entry.n}</span>
              <span className="dshd-cause-text">{entry.key}</span>
            </button>
          ))}
        </div>
      )}
      <div className="dshd-batch-row">
        <label className="dshd-check">
          <input type="checkbox" checked={allOn} disabled={visibleIds.length === 0}
            onChange={() => { setSelected(allOn ? new Set() : new Set([...selected, ...visibleIds])) }} />
          {t('batch.selectShown', { n: visibleIds.length })}
        </label>
        <span className="dshd-batch-n">{t('batch.selected', { n: selected.size })}</span>
        <span className="dshd-grow" />
        <button type="button" className="dshd-btn" onClick={onExit}>{t('batch.exit')}</button>
      </div>
      {action === null
        ? (
            <div className="dshd-batch-acts">
              {BATCH_ACTIONS.map(entry => (
                <button key={entry} type="button" className="dshd-pill" data-tone={entry === 'cancel' ? 'bad' : undefined}
                  disabled={selected.size === 0 || busy}
                  onClick={() => { setAction(entry); setResult(null) }}>
                  {t(`batch.act.${entry}`)}
                </button>
              ))}
            </div>
          )
        : (
            <div className="dshd-confirm" role="alertdialog" aria-label={t('batch.confirmTitle')}>
              <p>{t('batch.confirm', { n: selected.size, action: t(`batch.act.${action}`) })}</p>
              {action === 'reassign' && (
                <select aria-label={t('ra.partition')} value={target} onChange={(event) => { setTarget(event.target.value) }}>
                  <option value="">{t('batch.samePartition')}</option>
                  {partitions.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
                </select>
              )}
              <ul className="dshd-confirm-list">
                {[...selected].slice(0, 5).map(id => <li key={id}>{titleOf.get(id) ?? id}</li>)}
                {selected.size > 5 && <li>{t('batch.andMore', { n: selected.size - 5 })}</li>}
              </ul>
              <div className="dshd-dialog-btns">
                <button type="button" className="dshd-btn" onClick={() => { setAction(null) }}>{t('ra.cancel')}</button>
                <button type="button" className="dshd-btn" data-tone={action === 'cancel' ? 'bad' : 'primary'} disabled={busy}
                  onClick={() => { void run() }}>
                  {busy ? t('batch.running') : t('batch.go', { n: selected.size })}
                </button>
              </div>
            </div>
          )}
      {error !== '' && <div className="dshd-flash" data-tone="bad" role="alert">{error}</div>}
      {result !== null && (
        <div className="dshd-result" role="status">
          <span data-tone="ok">{t('batch.ok', { n: result.ok })}</span>
          {result.failed > 0 && <span data-tone="bad">{t('batch.failed', { n: result.failed })}</span>}
          {result.failed > 0 && (
            <ul>
              {result.results.filter(row => !row.ok).slice(0, 6).map(row => (
                <li key={row.id}><b>{titleOf.get(row.id) ?? row.id}</b>{row.error}</li>
              ))}
            </ul>
          )}
          <button type="button" className="dshd-x" aria-label={t('live.close')} onClick={() => { setResult(null) }}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// stylesheet
// ---------------------------------------------------------------------------

/** Desk styles; tokens come from BOARD_TOKENS_CSS (light and dark). */
export const DESK_CSS = `
.dshd-grow{flex:1 1 auto}
.dshd-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 14px;border:0;border-radius:var(--r-pill);background:var(--c-pill);color:var(--c-text);font-size:12px;font-weight:500;line-height:16px;white-space:nowrap;cursor:pointer;transition:background-color var(--dur) var(--ease),color var(--dur) var(--ease),transform .1s var(--ease)}
.dshd-btn:hover:not(:disabled){background:color-mix(in srgb,var(--c-pill) 80%,var(--c-text))}
.dshd-btn:active:not(:disabled){transform:scale(.97)}
.dshd-btn[data-tone="primary"]{background:var(--c-accent);color:var(--c-on-accent)}
.dshd-btn[data-tone="primary"]:hover:not(:disabled){background:var(--c-accent-hover)}
.dshd-btn[data-tone="primary"][data-armed]{background:var(--st-failed-dot)}
.dshd-btn[data-tone="bad"]{background:transparent;color:var(--st-failed-text);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--st-failed-dot) 45%,transparent)}
.dshd-btn[data-tone="bad"]:hover:not(:disabled){background:var(--st-failed-bg)}
.dshd-btn[data-tone="bad"][data-armed]{background:var(--st-failed-dot);color:#fff;box-shadow:none}
.dshd-btn:disabled{opacity:.45;cursor:default}
.dshd-pill{height:26px;padding:0 12px;border:1px solid var(--c-line);border-radius:var(--r-pill);background:var(--c-raised);color:var(--c-text);font-size:12px;cursor:pointer;transition:background-color var(--dur) var(--ease),border-color var(--dur) var(--ease)}
.dshd-pill:hover:not(:disabled){border-color:var(--c-ghost-line);background:var(--c-hover)}
.dshd-pill[data-tone="bad"]{color:var(--st-failed-text)}
.dshd-pill[aria-pressed="true"]{background:var(--st-failed-bg);border-color:transparent}
.dshd-pill:disabled{opacity:.45;cursor:default}
.dshd-x{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--c-text3);cursor:pointer}
.dshd-x:hover{background:var(--c-hover);color:var(--c-text)}
.dshd-flash{margin:0 0 var(--sp-2);padding:var(--sp-2) var(--sp-3);border-radius:10px;background:var(--st-done-bg);color:var(--st-done-text);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dshd-flash[data-tone="bad"]{background:var(--st-failed-bg);color:var(--st-failed-text)}

/* 等你确认 */
.dshd-ap{display:flex;flex-direction:column;gap:var(--sp-2);margin:var(--sp-3) var(--sp-2) 0}
.dshd-cap{display:flex;align-items:center;gap:6px;padding:0 var(--sp-1);font-size:12px;font-weight:600;color:var(--c-text)}
.dshd-cap-dot{width:7px;height:7px;border-radius:50%;background:var(--st-blocked-dot);box-shadow:0 0 0 3px color-mix(in srgb,var(--st-blocked-dot) 22%,transparent)}
.dshd-cap-n{min-width:18px;height:18px;padding:0 6px;border-radius:var(--r-pill);background:var(--c-pill);color:var(--c-text2);font-size:11px;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
.dshd-card{display:flex;flex-direction:column;gap:6px;padding:14px 16px;border-radius:var(--r-card);background:var(--c-raised);box-shadow:var(--shadow-1),inset 0 0 0 1px var(--c-line-soft);animation:dshd-in .24s var(--ease)}
@keyframes dshd-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.dshd-card-top{display:flex;align-items:center;gap:6px;font-size:11px;line-height:16px}
.dshd-kind{padding:1px 8px;border-radius:var(--r-pill);background:var(--c-surface);color:var(--c-text2);font-weight:600}
.dshd-kind[data-kind="merge"]{background:var(--st-running-bg);color:var(--st-running-text)}
.dshd-kind[data-kind="ops"]{background:var(--st-blocked-bg);color:var(--st-blocked-text)}
.dshd-rev{color:var(--c-text3)}
.dshd-rev[data-rev="no"]{color:var(--st-failed-text)}
.dshd-when{margin-left:auto;color:var(--c-text3);font-variant-numeric:tabular-nums}
.dshd-card-title{margin:0;font-size:14px;font-weight:600;line-height:20px;letter-spacing:-.01em;color:var(--c-text)}
.dshd-target{display:block;max-width:100%;padding:6px 10px;border-radius:8px;background:var(--c-surface);color:var(--c-text);font-family:var(--f-mono);font-size:11.5px;line-height:17px;overflow-wrap:anywhere;text-decoration:none;white-space:pre-wrap}
a.dshd-target{color:var(--c-accent)}
a.dshd-target:hover{text-decoration:underline}
.dshd-reason{margin:0;font-size:12px;line-height:18px;color:var(--c-text2);white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.dshd-from{margin:0;font-size:11px;color:var(--c-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshd-card-btns{display:flex;justify-content:flex-end;gap:var(--sp-2);margin-top:2px}
.dshd-reject{display:flex;gap:var(--sp-2);align-items:center;margin-top:2px}
.dshd-reject input,.dshd-field input,.dshd-field select,.dshd-batch select,.dshd-confirm select{flex:1 1 auto;min-width:0;height:30px;padding:0 10px;border:1px solid var(--c-line);border-radius:8px;background:var(--c-raised);color:var(--c-text);font:inherit;font-size:12.5px}
.dshd-reject input:focus,.dshd-field input:focus,.dshd-field select:focus,.dshd-batch select:focus{outline:none;border-color:var(--c-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--c-accent) 22%,transparent)}

/* 实时输出 */
.dshd-live{position:relative;margin:2px var(--sp-2) var(--sp-3) 20px;border-radius:var(--r-card);background:var(--c-raised);box-shadow:var(--shadow-1),inset 0 0 0 1px var(--c-line-soft);overflow:hidden;animation:dshd-in .24s var(--ease)}
.dshd-live-head{display:flex;align-items:center;gap:6px;min-width:0;padding:10px 8px 4px 12px}
.dshd-live-acts{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 10px;border-bottom:1px solid var(--c-line-soft)}
.dshd-live-acts:empty{display:none}
.dshd-live-dot{width:7px;height:7px;border-radius:50%;background:var(--c-text3)}
.dshd-live-dot[data-on]{background:var(--st-running-dot);animation:dshrc-pulse 1.6s ease-in-out infinite}
.dshd-live-title{font-size:12px;font-weight:600}
.dshd-live-state{font-size:11px;color:var(--c-text3)}
.dshd-live-body{max-height:320px;overflow:auto;padding:8px 0;background:var(--c-code);scrollbar-width:thin}
.dshd-live-empty{padding:20px;text-align:center;color:var(--c-text3);font-size:12px}
.dshd-seg{margin:0 8px;padding:6px 8px 6px 10px;border-left:2px solid transparent;border-radius:6px}
.dshd-seg+.dshd-seg{margin-top:2px}
.dshd-seg[data-error]{border-left-color:var(--st-failed-dot);background:var(--st-failed-bg)}
.dshd-seg-head{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:18px}
.dshd-seg-prompt{flex:none;color:var(--c-text3);font-family:var(--f-mono)}
.dshd-seg-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--f-mono);font-size:11.5px;color:var(--c-text)}
.dshd-seg[data-kind="message"] .dshd-seg-title{font-family:var(--f-ui);color:var(--c-text3);font-size:11px}
.dshd-seg[data-kind="end"] .dshd-seg-title{font-family:var(--f-ui);color:var(--c-text3);font-size:11px}
.dshd-seg-tag{flex:none;padding:0 6px;border-radius:var(--r-pill);background:var(--st-failed-dot);color:#fff;font-size:10.5px;line-height:16px;font-weight:600}
.dshd-seg-spin{flex:none;width:10px;height:10px;border:1.5px solid var(--c-line);border-top-color:var(--st-running-dot);border-radius:50%;animation:dshrc-spin .8s linear infinite}
.dshd-seg-time{flex:none;color:var(--c-text3);font-size:10.5px;font-variant-numeric:tabular-nums}
.dshd-seg-body{margin:4px 0 0 14px;max-height:180px;overflow:auto;font-family:var(--f-mono);font-size:11px;line-height:16px;color:var(--c-text2);white-space:pre-wrap;overflow-wrap:anywhere}
.dshd-seg[data-error] .dshd-seg-body{color:var(--st-failed-text)}
.dshd-seg[data-kind="message"] .dshd-seg-body{font-family:var(--f-ui);font-size:12px;line-height:18px;color:var(--c-text)}
.dshd-jump{position:absolute;right:12px;bottom:10px;height:26px;padding:0 12px;border:0;border-radius:var(--r-pill);background:var(--c-accent);color:var(--c-on-accent);font-size:11.5px;box-shadow:var(--shadow-2);cursor:pointer}

/* 改派 dialog */
.dshd-scrim{position:absolute;inset:0;z-index:20;display:flex;align-items:flex-start;justify-content:center;padding:56px 12px 12px;background:var(--c-scrim);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:dshd-fade .18s var(--ease)}
@keyframes dshd-fade{from{opacity:0}to{opacity:1}}
.dshd-dialog{display:flex;flex-direction:column;gap:12px;width:100%;max-width:420px;max-height:100%;overflow:auto;padding:20px;border-radius:18px;background:var(--c-raised);box-shadow:var(--shadow-2);animation:dshd-in .22s var(--ease)}
.dshd-dialog-title{margin:0;font-size:17px;font-weight:600;letter-spacing:-.02em}
.dshd-dialog-sub{margin:-6px 0 0;font-size:12.5px;color:var(--c-text2)}
.dshd-dialog-why{display:flex;flex-direction:column;gap:2px;margin:0;padding:8px 10px;border-radius:10px;background:var(--st-failed-bg);color:var(--st-failed-text);font-size:12px;line-height:17px;overflow-wrap:anywhere}
.dshd-dialog-why span{font-size:11px;font-weight:600}
.dshd-field{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:500;color:var(--c-text2)}
.dshd-choice{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0;padding:0;border:0}
.dshd-choice legend{margin-bottom:4px;padding:0;font-size:11.5px;font-weight:500;color:var(--c-text2)}
.dshd-choice label{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:12px;background:var(--c-surface);box-shadow:inset 0 0 0 1px transparent;cursor:pointer;transition:box-shadow var(--dur) var(--ease),background-color var(--dur) var(--ease)}
.dshd-choice label[data-on]{background:var(--c-raised);box-shadow:inset 0 0 0 2px var(--c-accent)}
.dshd-choice input{margin:3px 0 0;accent-color:var(--c-accent)}
.dshd-choice span{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshd-choice b{font-size:13px;font-weight:600;color:var(--c-text)}
.dshd-choice small{font-size:11px;line-height:15px;color:var(--c-text3)}
.dshd-dialog-err{margin:0;color:var(--st-failed-text);font-size:12px;overflow-wrap:anywhere}
.dshd-dialog-btns{display:flex;justify-content:flex-end;gap:var(--sp-2)}

/* 批量 */
.dshd-batch{display:flex;flex-direction:column;gap:var(--sp-2);margin:var(--sp-3) var(--sp-2) 0;padding:12px;border-radius:var(--r-card);background:var(--c-surface)}
.dshd-batch-filters{display:flex;gap:6px;flex-wrap:wrap}
.dshd-batch-filters select{flex:1 1 120px}
.dshd-causes{display:flex;flex-direction:column;gap:4px}
.dshd-cause{display:flex;align-items:center;gap:8px;min-width:0;padding:6px 10px;border:0;border-radius:10px;background:var(--c-raised);color:var(--c-text);font-size:12px;text-align:left;cursor:pointer;box-shadow:inset 0 0 0 1px var(--c-line-soft)}
.dshd-cause:hover{box-shadow:inset 0 0 0 1px var(--c-ghost-line)}
.dshd-cause-n{flex:none;min-width:22px;height:20px;padding:0 6px;border-radius:var(--r-pill);background:var(--st-failed-bg);color:var(--st-failed-text);font-weight:600;font-size:11px;line-height:20px;text-align:center}
.dshd-cause-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--f-mono);font-size:11px}
.dshd-batch-row{display:flex;align-items:center;gap:var(--sp-2);font-size:12px}
.dshd-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.dshd-check input,.dshrc-pick{accent-color:var(--c-accent)}
.dshd-batch-n{color:var(--c-text3);font-variant-numeric:tabular-nums}
.dshd-batch-acts{display:flex;gap:6px;flex-wrap:wrap}
.dshd-confirm{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:12px;background:var(--c-raised);box-shadow:var(--shadow-1)}
.dshd-confirm p{margin:0;font-size:13px;font-weight:600}
.dshd-confirm-list{margin:0;padding-left:18px;font-size:12px;color:var(--c-text2)}
.dshd-result{position:relative;display:flex;flex-wrap:wrap;gap:4px 10px;padding:10px 36px 10px 12px;border-radius:12px;background:var(--c-raised);font-size:12px}
.dshd-result [data-tone="ok"]{color:var(--st-done-text);font-weight:600}
.dshd-result [data-tone="bad"]{color:var(--st-failed-text);font-weight:600}
.dshd-result ul{flex-basis:100%;margin:0;padding-left:16px;color:var(--c-text2)}
.dshd-result li b{margin-right:6px;color:var(--c-text);font-weight:500}
.dshd-result .dshd-x{position:absolute;top:6px;right:6px}
`
