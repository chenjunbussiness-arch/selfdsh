/**
 * Load the built browser bundle the way the Web shell does, then check that it
 * registers what it claims and that the registered component actually renders.
 *
 * This is the load verification that is possible without installing the plugin
 * into a profile (which is out of bounds for this task): the envelope, the
 * `require` table, Cordis' `apply(ctx)` contract, slot registration, and the
 * component's first render are all exercised against the real built artifact and
 * the real React the shell provides.
 *
 * Assertions:
 *   1. the file calls `window.__ModuleLoader__.load({ id, factory })` with this
 *      package's name;
 *   2. the factory returns `{ apply, inject }`;
 *   3. `apply(ctx)` registers the right-Sidebar tab type, the keyed tab body, the
 *      tab title, and the conversation-header entry;
 *   4. the tab body renders — from sample data — the project rail (partitions,
 *      per-partition switch, API-key status), the four board tabs, the sections
 *      with `reported` and `verified` kept apart, a worker checklist with its
 *      current step, and a released worker.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Scripts live one level below the package root; resolve from the file itself.
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const file = join(root, 'lib', 'client.js')
const source = await readFile(file, 'utf8')

const failures = []
const check = (ok, label) => {
  if (ok) console.log(`  ok   ${label}`)
  else { console.log(`  FAIL ${label}`); failures.push(label) }
}

/* ---------- 1. envelope ---------- */

let loaded
const window = {
  __ModuleLoader__: {
    load(entry) {
      check(typeof entry.id === 'string' && entry.id === pkg.name, `envelope id is ${pkg.name}`)
      check(typeof entry.factory === 'function', 'envelope carries a factory')
      loaded = entry
    },
  },
}
// The bundle is a browser CJS artifact: `require` is the loader's module table,
// so the harness answers it with the real installed React, exactly as the shell
// would.
const nodeRequire = createRequire(join(root, 'package.json'))
const requireStub = (specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier.startsWith('react-dom')) {
    return nodeRequire(specifier)
  }
  throw new Error(`bundle requested "${specifier}", which is not part of the module table for this plugin`)
}

const sandbox = { window, console, require: requireStub, module: { exports: {} }, exports: {}, process: { env: {} } }
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

check(loaded !== undefined, 'window.__ModuleLoader__.load was called')

/* ---------- 2. exports ---------- */

const exportsObject = loaded.factory(requireStub)
check(typeof exportsObject.apply === 'function', 'exports.apply is a function')
check(Array.isArray(exportsObject.inject), 'exports.inject is an array')
check(
  exportsObject.inject.includes('slots') && exportsObject.inject.includes('sidebarRightTabs'),
  `exports.inject = ${JSON.stringify(exportsObject.inject)}`,
)

/* ---------- 3. registrations ---------- */

const tabTypes = []
const injections = []
const registrations = []
const dictionaries = {}

const ctx = {
  slots: {
    inject(key, callback) {
      injections.push(key)
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ options, component, injectFn: options.inject })
      return () => {}
    },
    entries: () => [],
  },
  locale: {
    register(ns, dictionary) {
      dictionaries[ns] = dictionary
      return () => {}
    },
    bind() {
      return (key, values) => {
        let text = dictionaries['router.board']?.zh?.[key] ?? key
        for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
        return text
      }
    },
  },
  sidebarRightTabs: {
    register(definition) {
      tabTypes.push(definition)
      return () => {}
    },
  },
  sidebarRight: {
    openTab(kind) { openings.push(kind) },
    tabsIn: () => [],
  },
  effect(callback) {
    callback()
    return () => {}
  },
  inject(_deps, callback) {
    callback(ctx)
    return () => {}
  },
}
const openings = []

exportsObject.apply(ctx)

check(tabTypes.length === 1, 'registered exactly one right-Sidebar tab type')
check(tabTypes[0]?.id !== undefined && tabTypes[0]?.kind === 'router-board', `tab type kind = ${tabTypes[0]?.kind}`)
check(tabTypes[0]?.priority === 'extension', 'tab type priority is extension (an outside type)')
check(injections.includes('sidebar.right.pane.tab'), 'registered into sidebar.right.pane.tab')
check(injections.includes('sidebar.right.pane.tab.title'), 'registered into sidebar.right.pane.tab.title')
check(injections.includes('conversation.session.header.utilities'), 'registered a conversation-header entry')
check(Object.keys(dictionaries).includes('router.board'), 'registered its locale namespace')

const body = registrations.find(entry => entry.options.name === 'sidebar.right.pane.tab')
check(body !== undefined, 'tab body registration was recorded')
check(body?.options.key === tabTypes[0]?.id, 'tab body key matches the tab type id')

/* ---------- 4. first render ---------- */

const props = body.injectFn()
await props.controller.load()
const markup = renderToStaticMarkup(createElement(body.component, props))

const expect = (needle, label) => check(markup.includes(needle), label)
expect('dshr-panel', 'panel root rendered')
expect('任务面板', 'panel title rendered')
expect('分区花名册', 'roster section rendered')
expect('rca-ab-test', 'partition name rendered from sample data')
expect('已释放', 'a released worker is labelled as released')
expect('待验收', 'the reported lane exists')
expect('已完成', 'the verified lane exists')
expect('工作清单', 'a task checklist rendered')
expect('正在做：', 'the current step is called out')
expect('3/7', 'checklist progress rendered')
expect('通过验收', 'a reported task offers verification')
expect('待派', 'the dispatch lane exists')

// --- left rail: projects you can act on, and the API-key status block --------

expect('dshr-rail', 'the project rail rendered inside the panel')
expect('dshr-switch', 'every partition row carries its own enable/disable switch')
expect('API Key', 'the rail carries the API-key block')
expect('DEEPSEEK_API_KEY', 'a credential row names its reference')
expect('已配置', 'a credential reports "configured"')
expect('未配置', 'a credential reports "not configured"')
check(!markup.includes('type="password"'), 'no credential input is rendered until the user asks to set one')
expect('dshr-project-all', 'the rail renders the "all projects" filter row')

// --- right column: four tabs over grouped sections --------------------------

const tabs = markup.match(/data-tab="[a-z]+"/g) ?? []
check(tabs.length === 4, `four board tabs rendered (${tabs.join(', ')})`)
for (const id of ['active', 'next', 'scheduled', 'resolved']) {
  check(tabs.includes(`data-tab="${id}"`), `tab "${id}" is in the strip`)
}
check(/data-tab="active"[^>]*aria-selected="true"/.test(markup), 'the first tab opens selected')
expect('data-lane="running"', 'the running tasks are their own group inside the tab')
expect('data-lane="queued"', 'the dispatch group exists')
expect('排程', 'the scheduled group exists')
// Closed tabs are hidden in place, not dropped: the strip is a view switch over
// one list, so a section outside the selected tab never renders as content.
check(/data-lane="verified"[^>]*hidden/.test(markup), 'a section outside the selected tab is hidden')
check(!/data-lane="reported"[^>]*hidden/.test(markup), 'a section inside the selected tab is visible')
check(/class="dshr-task-row" aria-expanded="false"/.test(markup), 'a task renders as a compact collapsed row')
check(/class="dshr-task-body" hidden/.test(markup), 'the row detail exists but is closed until asked for')

// reported and verified must be different lanes with different tasks: collapse
// them and this assertion fails.
const reportedLane = markup.split('data-lane="reported"')[1]?.split('data-lane="verified"')[0] ?? ''
const verifiedLane = markup.split('data-lane="verified"')[1] ?? ''
check(reportedLane.includes('补 registry.json'), 'a self-reported task sits in the reported lane')
check(!reportedLane.includes('client 插件加载失败时要有可见错误'), 'a verified task is NOT in the reported lane')
check(verifiedLane.includes('client 插件加载失败时要有可见错误'), 'the verified task sits in the verified lane')
check(!verifiedLane.includes('补 registry.json'), 'the self-reported task is NOT in the verified lane')


/* ---------- 5. native projection path ---------- */

// A worker's checklist must be able to come from the Harness's own `todos`
// projection instead of a Host task payload: same panel, live Session data.
const projectionSnapshot = {
  projectionsBySession: {
    ses_rca1: {
      state: 'ready',
      values: {
        todos: [
          { content: '读 rca-state 的 build 报错', status: 'completed' },
          { content: '定位 vendor 里缺失的符号', status: 'completed' },
          { content: '改 internal/mcpserver/registry.json', status: 'completed' },
          { content: '跑 go build ./...', status: 'completed' },
          { content: '跑 go vet ./...', status: 'in_progress' },
          { content: '补一条回归单测', status: 'pending' },
          { content: '写任务记录 task.md', status: 'pending' },
        ],
      },
    },
  },
}
const sessionsFace = {
  list: {
    getSnapshot: () => projectionSnapshot,
    subscribe: () => () => {},
  },
  refreshProjections: async () => {},
}
const projectedMarkup = renderToStaticMarkup(createElement(body.component, { ...props, sessions: sessionsFace }))
check(projectedMarkup.includes('4/7'), 'worker checklist is read from the Session todos projection (4/7, not the 3/7 payload)')
check(projectedMarkup.includes('跑 go vet ./...'), 'the live projection content is rendered')
check(!projectedMarkup.includes('3/7'), 'the stale Host payload count is replaced by the live projection')
console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} assertion(s) failed`)
  process.exitCode = 1
} else {
  console.log(`all assertions passed — ${file} loads and registers as a right-Sidebar panel`)
}
