/**
 * Agent roles — one optional field on top of `dsh-agent/1.0` / `dsh-agent/2.0`.
 *
 *   worker      takes any task. THE DEFAULT: an agent that never sends a role,
 *               and every agent stored before roles existed, is a worker.
 *               Where a coder is online, a worker runs the tests, commands and git
 *               after the coder's edit rather than doing the whole job alone.
 *   coder       edits code only (AWS Quick and the like: no shell, no CLI). A task
 *               that needs tests, commands or git (see {@link taskNeeds}) is refused:
 *               the dispatcher splits it, edit -> coder, then test + git -> worker.
 *   tester      takes test tasks only: `type` is custom or review, or the title
 *               names a test (冒烟 / 测试 / smoke / test). Anything else is refused.
 *   dispatcher  dispatches work and never takes any: task_dispatch refuses it.
 *   observer    read-only (panel / lists), never takes any: task_dispatch refuses it.
 *
 * Everything here is a pure function so the same policy serves
 *   - the hub core (hub.js: enroll, approve, dispatch, poll, listings) and
 *   - the controller tools (tools.js: a task_dispatch pre-check, agent_approve).
 * Errors are returned as `{ code, message }` (the caller throws its own HubError),
 * so this module stays free of either HubError class.
 *
 * Code names follow the existing hub style (`bad-mode`, `grant-widened`):
 *   bad-role              not one of the four roles
 *   role-widened          approve tried to WIDEN the requested role
 *   role-not-dispatchable the target role never takes tasks (dispatcher / observer)
 *   role-not-testable     the target is a tester and the task is not a test
 *   role-not-coding       the target is a coder and the task needs tests, commands or git
 *
 * @module host-agent-hub/roles
 */

/** The four roles, in listing order. */
export const ROLES = ['dispatcher', 'tester', 'coder', 'worker', 'observer']

/** Role of an agent that never sent one (backward compatible). */
export const DEFAULT_ROLE = 'worker'

/** Task types a tester accepts beyond a test-shaped title. */
export const TEST_TASK_TYPES = ['custom', 'review']

/** A title naming a test (`冒烟` / `测试` / `smoke` / `test`, any case). */
export const TEST_TITLE_RE = /冒烟|测试|smoke|test/i

/**
 * How much work a role may do: 0 = nothing, 3 = anything. `approve` may only
 * lower it (a request may ask for a wider role than DSH grants, never the
 * other way round), which is what `role-widened` guards.
 */
export const ROLE_RANK = Object.freeze({ observer: 0, dispatcher: 1, tester: 2, coder: 2, worker: 3 })

/**
 * What a task needs from its worker. `code` = edit files; `test` = run tests;
 * `git` = commit / push / open or merge a PR; `cmd` = run any other command or script.
 * A dispatcher may say it (`needs` on the task); otherwise {@link taskNeeds} reads the text.
 */
export const NEEDS = ['code', 'test', 'git', 'cmd']

/** What only a worker may do (a coder never): everything but editing. */
export const RUN_NEEDS = ['test', 'git', 'cmd']

/**
 * Phrases that ASK a worker to run something. Only asks count: "写单元测试" or
 * "修 test 文件" is editing code, "跑测试" / "npm test" / "git push" is running.
 */
const RUN_ASKS = [
  ['test', /(?:跑|运行|执行|\brun\b)[^，。；,.;\n]{0,12}?(?:测试|单测|用例|\btests?\b|\bspecs?\b)|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bnode\s+--test\b|\b(?:go|cargo|mvn|gradle)\s+test\b|验证(?:测试)?(?:是否)?(?:全部)?通过/i],
  ['git', /\bgit\s+(?:add|commit|push|merge|rebase|checkout|switch|pull|tag|reset|stash)\b|(?:提交|推送|推)(?:代码|改动|修改|到\s*(?:远端|远程|仓库|github|gitea|分支|main))|(?:开|提|建|创建|发)\s*(?:一个\s*)?(?:PR|pr|MR|pull request)|\b(?:open|create|merge)\s+(?:a\s+|the\s+)?(?:PR|pull request)\b|合并\s*(?:PR|pr|MR)/],
  ['cmd', /(?:执行|运行|跑)[^，。；,.;\n]{0,8}?(?:命令|脚本|\bcmd\b|\bshell\b|\bbash\b|powershell|pwsh)|^\s*(?:命令|command)\s*[:：]|命令行里|终端里|\b(?:npm|pnpm|yarn)\s+(?:i|install|run|build)\b|\bpip\s+install\b|\brun\s+(?:the\s+|this\s+)?(?:command|script)\b|部署到|重启服务|\bdeploy\b/im],
]

/** "不要跑测试" / "don't push" ask the opposite: a run ask right after one of these does not count. */
const NEGATED = /(?:不要|不用|别|不必|无需|不需要|禁止|不能|不许|不|勿|don't|do not|no need to|never|without)\s*$/i

/** The run needs the text asks for (`test` / `git` / `cmd`), each named once, in NEEDS order. */
export function textRunNeeds(text) {
  const found = new Set()
  const source = String(text ?? '')
  for (const [need, re] of RUN_ASKS) {
    const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    for (const m of source.matchAll(all)) {
      if (NEGATED.test(source.slice(Math.max(0, m.index - 12), m.index))) continue
      found.add(need)
      break
    }
  }
  return RUN_NEEDS.filter(n => found.has(n))
}

/** A dispatcher's `needs`: the valid entries in NEEDS order, or `undefined` when it sent none (or not a list). */
export function needsOf(value) {
  if (!Array.isArray(value)) return undefined
  return NEEDS.filter(n => value.includes(n))
}

/** `bad-needs` refusal, or `undefined` when absent or valid. */
export function needsProblem(value) {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > NEEDS.length || value.some(n => !NEEDS.includes(n))) {
    return { code: 'bad-needs', message: `needs must be a non-empty list of ${NEEDS.join(', ')}` }
  }
  return undefined
}

/**
 * What the task needs: what the dispatcher said (`needs`), plus `code` for a code task,
 * plus whatever the title and instruction ask to run. The text always counts: a task
 * marked `needs: ["code"]` whose instruction still says "跑测试" asks a coder to test.
 */
export function taskNeeds(task) {
  const found = new Set(needsOf(task?.needs) ?? [])
  if (task?.type === 'code') found.add('code')
  for (const n of textRunNeeds(`${String(task?.title ?? '')}\n${String(task?.instruction ?? '')}`)) found.add(n)
  return NEEDS.filter(n => found.has(n))
}

/** Words for each need, in the refusal and the duties. */
const NEED_WORDS = { code: '改代码', test: '跑测试', git: 'git（提交、推送、开 PR）', cmd: '执行命令或脚本' }

/**
 * What each role may and may not do, in the words the dispatcher and the worker read
 * (agent_list, the task a worker leases). `handoff` says where the rest goes.
 */
export const ROLE_DUTIES = Object.freeze({
  worker: Object.freeze({
    can: Object.freeze(['改代码', '跑测试', '执行命令或脚本', 'git（提交、推送、开 PR）']),
    cannot: Object.freeze([]),
    handoff: '有 coder 在线时，改代码交给 coder；worker 接它之后的跑测试和 git，不一个人包到底。',
  }),
  coder: Object.freeze({
    can: Object.freeze(['改代码（读写工作区文件，交 changes.patch）']),
    cannot: Object.freeze(['跑测试', '执行命令或脚本', 'git（提交、推送、开 PR）']),
    handoff: '改完就交结果，写清改了哪些文件；跑测试和 git 由调度方另派给 worker。任务要求越界时不做那部分，用 needs_input 交回并说明。',
  }),
  tester: Object.freeze({
    can: Object.freeze(['跑测试（test 类任务）']),
    cannot: Object.freeze(['改代码', '执行别的命令', 'git']),
    handoff: '测出问题就交结果写清失败项，修复由调度方另派。',
  }),
  dispatcher: Object.freeze({ can: Object.freeze(['派活']), cannot: Object.freeze(['接任何任务']), handoff: '' }),
  observer: Object.freeze({ can: Object.freeze(['看任务板']), cannot: Object.freeze(['接任何任务']), handoff: '' }),
})

/** The duties of a role, as plain data: `{ role, can, cannot, handoff }`. */
export function roleDuties(role) {
  const r = isRole(role) ? role : DEFAULT_ROLE
  const d = ROLE_DUTIES[r]
  return { role: r, can: [...d.can], cannot: [...d.cannot], ...d.handoff === '' ? {} : { handoff: d.handoff } }
}

/** One line a worker reads first in its task: what it may do here and where the rest goes. */
export function roleBoundary(role) {
  const d = roleDuties(role)
  const cannot = d.cannot.length === 0 ? '' : `；不能${d.cannot.join('、')}`
  return `你的角色是 ${d.role}：能${d.can.join('、')}${cannot}。${d.handoff ?? ''}`.trim()
}

/** True for one of the four role names. */
export function isRole(value) {
  return typeof value === 'string' && ROLES.includes(value)
}

/**
 * Normalize a caller-supplied role: absent / empty means {@link DEFAULT_ROLE},
 * an unknown value means `undefined` (the caller answers `bad-role`).
 */
export function roleOf(value) {
  if (value === undefined || value === null) return DEFAULT_ROLE
  if (typeof value !== 'string') return undefined
  const role = value.trim()
  if (role === '') return DEFAULT_ROLE
  return isRole(role) ? role : undefined
}

/** The role of a stored agent record: `worker` when the record has none. */
export function agentRole(agent) {
  return isRole(agent?.role) ? agent.role : DEFAULT_ROLE
}

/** `bad-role` refusal, or `undefined` for a valid role. */
export function roleProblem(value, label = 'role') {
  const role = roleOf(value)
  if (role === undefined) return { code: 'bad-role', message: `${label} must be one of ${ROLES.join(', ')} (default ${DEFAULT_ROLE})` }
  return undefined
}

/** True when the task is a test: `type` custom / review, or a test-shaped title. */
export function isTestTask(task) {
  if (TEST_TASK_TYPES.includes(task?.type)) return true
  return typeof task?.title === 'string' && TEST_TITLE_RE.test(task.title)
}

/** True when an agent of this role may take this task at all. */
export function roleAccepts(role, task) {
  if (role === 'worker') return true
  if (role === 'tester') return isTestTask(task)
  if (role === 'coder') return !taskNeeds(task).some(n => RUN_NEEDS.includes(n))
  return false // dispatcher and observer never take tasks
}

/** True for the roles that may take tasks (the only ones pool routing picks). */
export function roleTakesWork(role) {
  return role === 'worker' || role === 'tester' || role === 'coder'
}

/**
 * Why dispatching `task` to `target` (an agent id or `pool:<capability>`) is
 * refused by the target's role; `undefined` when it is allowed.
 * @returns {{ code: string, message: string } | undefined}
 */
export function roleRefusal(task, role, target) {
  const who = target === undefined ? `this ${String(role)}` : `${String(target)} (${String(role)})`
  if (role === 'dispatcher') {
    return { code: 'role-not-dispatchable', message: `${who} is a dispatcher: dispatchers dispatch work and never take tasks; dispatch to a worker instead` }
  }
  if (role === 'observer') {
    return { code: 'role-not-dispatchable', message: `${who} is an observer: observers only read the board and never take tasks; dispatch to a worker instead` }
  }
  if (role === 'tester' && !isTestTask(task)) {
    return {
      code: 'role-not-testable',
      message: `${who} is a tester: testers only take test tasks (type ${TEST_TASK_TYPES.join('/')}, or a title naming 冒烟/测试/smoke/test), but this task is type "${String(task?.type ?? 'custom')}" titled "${String(task?.title ?? '').slice(0, 80)}"`,
    }
  }
  if (role === 'coder') {
    const run = taskNeeds(task).filter(n => RUN_NEEDS.includes(n))
    if (run.length > 0) {
      return {
        code: 'role-not-coding',
        message: `${who} 是 coder：只改代码，不能${run.map(n => NEED_WORDS[n]).join('、')}。请拆开派：改代码的部分派给 coder，`
          + `${run.map(n => NEED_WORDS[n]).join('、')}另派给 worker（role worker，agent_list 可查），用 depends_on 接在改代码之后。`
          + '只改代码就把这几步从 instruction 里去掉（写成“不要跑测试”也行）。',
      }
    }
  }
  return undefined
}

/** Why `granted` widens the requested role; `undefined` when it narrows or keeps it. */
export function roleWidening(requested, granted) {
  const asked = agentRole({ role: requested })
  const want = agentRole({ role: granted })
  // Same rank, other role (tester <-> coder) is a change of kind, not a narrowing.
  if (ROLE_RANK[want] < ROLE_RANK[asked] || want === asked) return undefined
  return { code: 'role-widened', message: `role can only be narrowed at approval (${asked} -> ${want} widens it)` }
}

/** True when the role is stored (so `publicAgent` can always report it). */
export function hasRole(agent) {
  return isRole(agent?.role)
}
