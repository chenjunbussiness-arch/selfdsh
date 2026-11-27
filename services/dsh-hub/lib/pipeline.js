/**
 * Pipelines: one piece of work carried by several agents in stages (plan -> code ->
 * test -> commit -> review), each stage given to whoever CAN do it (roles.js `can`).
 *
 * The hub keeps a parent task (origin `pipeline`, never leased) and creates one child
 * task per stage, only when the stage before it is done, so the child can depend on
 * what came out of the earlier stages (their files arrive as inputs). A test that fails
 * or a review that sends the work back starts a new round from the code stage, at most
 * `maxBounces` times; then the parent waits on the human (task_answer).
 *
 * Templates come from hub.json `pipelines` (merged over the built-in ones below). A stage
 * names what it needs and, optionally, whom to prefer: agent ids in order, or `online`
 * for "whoever is online". Nothing here names a vendor: adding an agent is a
 * registration with the right `can`, not a code change.
 *
 * Pure functions only; hub.js owns the state.
 *
 * @module dsh-hub/pipeline
 */

import { NEEDS } from './roles.js'

export const STAGE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
export const PIPELINE_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/
export const ANY_TARGET = 'pool:*'
export const PIPELINE_AGENT = 'pipeline'
export const DEFAULT_MAX_BOUNCES = 2
export const MAX_BOUNCES_LIMIT = 10
export const MAX_STAGES = 12

/**
 * What each well-known stage means, so a template may name it with one word. A stage
 * of another name must say its `needs` itself.
 */
export const STAGE_DEFAULTS = Object.freeze({
  plan: { label: '方案', needs: ['plan'], required: ['plan.md', 'acceptance.md'] },
  code: { label: '干活', needs: ['code'], required: ['changes.patch'] },
  test: { label: '测试', needs: ['test'], required: ['test.log'], verdict: 'test' },
  commit: { label: '提交', needs: ['git'], required: [] },
  review: { label: '验收', needs: ['review'], required: ['review.md'], verdict: 'review', excludeAuthors: true },
  self: { label: '自己做', needs: ['code', 'test'], required: [] },
})

/** The built-in templates. hub.json `pipelines` adds to them or replaces one by name. */
export const DEFAULT_PIPELINES = Object.freeze({
  feature: ['plan', 'code', 'test', 'commit', 'review'],
  small: ['code', 'test', 'commit', 'review'],
  tiny: ['self'],
})

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9 _.()-]{0,127}$/
const AGENT_RE = /^[a-z][a-z0-9-]{1,47}$/

class PipelineError extends Error {}

/** One stage entry (a name, or an object) -> the full stage. Throws PipelineError. */
function stageOf(entry, where) {
  const raw = typeof entry === 'string' ? { stage: entry } : entry
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new PipelineError(`${where}: a stage is a name or an object`)
  const name = raw.stage
  if (typeof name !== 'string' || !STAGE_NAME_RE.test(name)) throw new PipelineError(`${where}: stage must be a short lowercase name`)
  const base = STAGE_DEFAULTS[name] ?? {}
  const needs = raw.needs ?? base.needs
  if (!Array.isArray(needs) || needs.length === 0 || needs.some(n => !NEEDS.includes(n))) {
    throw new PipelineError(`${where}: stage ${name} needs a "needs" list of ${NEEDS.join(', ')}`)
  }
  const prefer = raw.prefer ?? []
  if (!Array.isArray(prefer) || prefer.length > 16 || prefer.some(p => typeof p !== 'string' || (p !== 'online' && !AGENT_RE.test(p)))) {
    throw new PipelineError(`${where}: stage ${name}: prefer is a list of agent ids or "online"`)
  }
  const required = raw.required ?? base.required ?? []
  if (!Array.isArray(required) || required.length > 10 || required.some(f => typeof f !== 'string' || !FILE_RE.test(f) || f.includes('..'))) {
    throw new PipelineError(`${where}: stage ${name}: required is a list of file names`)
  }
  const verdict = raw.verdict ?? base.verdict
  if (verdict !== undefined && verdict !== 'test' && verdict !== 'review') throw new PipelineError(`${where}: stage ${name}: verdict is test or review`)
  const maxBounces = raw.maxBounces
  if (maxBounces !== undefined && (!Number.isInteger(maxBounces) || maxBounces < 0 || maxBounces > MAX_BOUNCES_LIMIT)) {
    throw new PipelineError(`${where}: stage ${name}: maxBounces must be 0..${MAX_BOUNCES_LIMIT}`)
  }
  if (raw.bounceTo !== undefined && (typeof raw.bounceTo !== 'string' || !STAGE_NAME_RE.test(raw.bounceTo))) throw new PipelineError(`${where}: stage ${name}: bounceTo is a stage name`)
  const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim().slice(0, 16) : base.label ?? name
  return {
    stage: name, label, needs: NEEDS.filter(n => needs.includes(n)), prefer: [...prefer], required: [...required],
    verdict, bounceTo: raw.bounceTo, maxBounces,
    excludeAuthors: raw.excludeAuthors ?? base.excludeAuthors ?? false,
    guide: typeof raw.guide === 'string' ? raw.guide.slice(0, 2000) : undefined,
  }
}

/** One template (a list of stages) -> the full stages. Throws PipelineError. */
export function templateOf(list, name) {
  const where = `pipelines.${name}`
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_STAGES) throw new PipelineError(`${where} must be a list of 1..${MAX_STAGES} stages`)
  const stages = list.map((entry, i) => stageOf(entry, `${where}[${i}]`))
  const names = stages.map(s => s.stage)
  if (new Set(names).size !== names.length) throw new PipelineError(`${where}: a stage name is used twice`)
  for (const [i, s] of stages.entries()) {
    if (s.verdict === undefined) continue
    const target = s.bounceTo ?? [...stages.slice(0, i)].reverse().find(e => e.needs.includes('code'))?.stage
    if (target === undefined) continue // nothing to go back to: a failing verdict asks the human
    const at = names.indexOf(target)
    if (at < 0 || at >= i) throw new PipelineError(`${where}: stage ${s.stage} bounces to ${target}, which is not an earlier stage`)
    s.bounceTo = target
  }
  return stages
}

/**
 * hub.json `pipelines` (or undefined) over the built-in templates -> { name: stages }.
 * Throws an Error with a hub.json message when something is wrong.
 */
export function pipelinesOf(raw) {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw new Error('hub.json: pipelines must be an object of { name: [stages] }')
  const all = { ...DEFAULT_PIPELINES, ...(raw ?? {}) }
  const out = {}
  try {
    for (const [name, list] of Object.entries(all)) {
      if (!PIPELINE_NAME_RE.test(name)) throw new PipelineError(`pipelines: "${name}" is not a short lowercase name`)
      if (list === null || list === false) continue // switch a built-in off
      out[name] = templateOf(list, name)
    }
  } catch (error) {
    if (error instanceof PipelineError) throw new Error(`hub.json: ${error.message}`)
    throw error
  }
  return out
}

/**
 * The verdict a test or review stage gave, from the first non-empty line of `text`:
 * 'pass', 'fail' or undefined (no verdict). "不通过" is checked before "通过".
 */
export function verdictOf(kind, text) {
  const first = String(text ?? '').split(/\r?\n/).map(l => l.replace(/^[#>*\s-]+/, '').trim()).find(l => l !== '') ?? ''
  const head = first.slice(0, 40).toLowerCase()
  if (kind === 'test') {
    if (/^(不通过|未通过|没通过|失败|fail|failed|failing)/.test(head)) return 'fail'
    if (/^(通过|全部通过|pass|passed|ok)/.test(head)) return 'pass'
    return undefined
  }
  if (/^(退回|不通过|驳回|打回|reject|rejected|changes requested|request changes)/.test(head)) return 'fail'
  if (/^(通过|验收通过|approve|approved|pass|lgtm)/.test(head)) return 'pass'
  return undefined
}

/** How a verdict must be written, for the refusal and the instruction. */
export function verdictHint(kind) {
  return kind === 'test'
    ? 'summary 第一行写“通过”或“不通过”（后面可以跟失败条数）'
    : 'review.md（或 summary）第一行写“通过”或“退回”，后面逐条写意见'
}

const MARK = { done: '✓', now: '✱', todo: '○', failed: '✗' }

/** One line for the 调度台 and the 作战室: 方案 ✓ → 干活 ✱ → 测试 ○ … (round when > 1). */
export function pipelineView(parent) {
  const p = parent.pipeline
  if (p === undefined) return undefined
  const ended = ['completed', 'failed', 'cancelled', 'dead'].includes(parent.status)
  const parts = p.stages.map((s, i) => {
    let mark = MARK.todo
    if (i < p.at || (parent.status === 'completed')) mark = MARK.done
    else if (i === p.at) mark = ended ? MARK.failed : MARK.now
    return `${s.label} ${mark}`
  })
  return `${parts.join(' → ')}${p.round > 1 ? `（第 ${p.round} 轮）` : ''}`
}

/** Words for each stage's part of the instruction (what to deliver, how to say the verdict). */
function stageGuide(stage, ctx) {
  const files = stage.required.length > 0 ? `必须交的文件：${stage.required.join('、')}（submit_result 的 files）。` : ''
  switch (stage.stage) {
    case 'plan':
      return '只出方案，不改代码。plan.md 写怎么改（改哪些文件、每处怎么改、风险），acceptance.md 写验收标准（逐条、可检查）。'
        + `后面的人照 plan.md 改、照 acceptance.md 验收。${files}`
    case 'code':
      return '照 plan.md 改代码（没有 plan.md 就照目标改）。只改代码：不跑测试、不执行命令、不碰 git。'
        + `${ctx.bounce ? `这是第 ${ctx.round} 轮：先读上一轮的 review.md / test.log，把里面指出的问题改掉。` : ''}`
        + `summary 写清改了哪些文件、为什么改。${files}用本机 MCP 桥时 changes.patch 会自动生成。`
    case 'test':
      return '只测试，不改业务代码，不提交。工作区里还没有这份改动时，先在 ref（没写就当前分支）上用 git apply 应用输入里的 changes.patch（不提交）。'
        + `${ctx.verify ? `只跑这些测试命令：${ctx.verify}。` : '按工作区自己的测试方式跑（README、package.json、Makefile 里写的）。'}`
        + `把完整输出放进 test.log。${verdictHint('test')}。测完把你自己应用的补丁撤掉，工作区恢复成领活前的样子。${files}`
    case 'commit':
      return `只做 git：从 changes.patch 开头注明的 base 提交（没写就用 ${ctx.ref ?? '当前分支'}）新建分支 ${ctx.branch}，`
        + '让工作区等于 base 加上 changes.patch（已经是这份改动就直接用），提交一次并推送这个分支。'
        + '不要合并、不要强推、不要改别的分支和标签。summary 第一行写分支名和提交号。'
    case 'review':
      return '只验收，不改代码。对照 acceptance.md 和 plan.md，看 changes.patch、test.log 和提交的分支，逐条判断。'
        + `${verdictHint('review')}。${files}`
    case 'self':
      return '一个人做完：改代码并跑测试，不碰 git。summary 写清改了什么、测试结果。'
    default:
      return `${files}`
  }
}

/** The instruction of one stage's child task: the goal, then what this stage does. */
export function stageInstruction(parent, stage, ctx = {}) {
  const p = parent.pipeline
  const lines = [
    `这是流水线「${parent.title}」（${p.name}：${p.stages.map(s => s.label).join(' → ')}）的「${stage.label}」段，第 ${ctx.round ?? p.round} 轮。`,
    '',
    '目标：',
    parent.instruction,
    '',
    `这一段只做：${stageGuide(stage, { ...ctx, ref: parent.ref, verify: p.verify, branch: ctx.branch })}`,
  ]
  if (stage.guide) lines.push('', stage.guide)
  if (ctx.feedback) lines.push('', `人给的话：${ctx.feedback}`)
  if (Array.isArray(ctx.inputs) && ctx.inputs.length > 0) {
    lines.push('', `输入（get_input，带 from_task）：${ctx.inputs.map(i => `${i.name}（${i.from_label ?? i.from_task}）`).join('、')}`)
  }
  return lines.join('\n')
}

/** The branch a commit stage pushes, one per round (never rewritten). */
export function branchOf(parent, round) {
  return `pipeline/${parent.task_id}-r${round}`.replace(/[^A-Za-z0-9._/-]/g, '-').slice(0, 120)
}

/** The parent's closing summary: one line per stage of the last round, who did it and what came out. */
/**
 * The gist of a stage's summary: its first non-empty line, plus the lines after it when
 * that line only leads into a list ("改了两个文件："), at most `max` characters.
 */
export function gist(text, max = 200) {
  const lines = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(l => l !== '')
  let line = lines[0] ?? ''
  if (/[:：]$/.test(line)) for (let i = 1; i < lines.length && line.length < max; i++) line = `${line} ${lines[i]}`
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function finalSummary(parent, children, outcome) {
  const p = parent.pipeline
  const last = new Map()
  for (const c of children) last.set(c.stage, c)
  const rows = p.stages.map((s) => {
    const c = last.get(s.stage)
    if (c === undefined) return `- ${s.label}：没做到这一段`
    return `- ${s.label}（${c.by ?? '?'}）：${gist(c.summary)}`
  })
  const head = outcome === 'completed'
    ? `流水线 ${p.name} 跑完${p.round > 1 ? `，第 ${p.round} 轮通过` : ''}。`
    : `流水线 ${p.name} 停在「${p.stages[p.at]?.label ?? '?'}」段。`
  return [head, ...rows].join('\n')
}
