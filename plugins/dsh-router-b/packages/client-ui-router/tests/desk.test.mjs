/**
 * Desk tests: 等你确认, 实时输出, 改派, 批量 and the day/night theme.
 *
 * Bundles the real sources with esbuild (React stays external) and checks:
 * - the pure helpers (failure-cause grouping, live segment merging, theme
 *   resolution);
 * - the mock source and the controller through the same calls the UI makes;
 * - the first render of the board: theme attribute, theme button, batch toggle,
 *   PR link and 改派 links on rows, output/改派 row actions;
 * - the stylesheet: light and dark token blocks both present.
 *
 * Run: node --test tests/desk.test.mjs   (from packages/client-ui-router)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

// Inside the package, so the bundle's `require('react')` resolves to this package's React.
await mkdir(join(root, 'node_modules', '.cache'), { recursive: true })
const dir = await mkdtemp(join(root, 'node_modules', '.cache', 'dshr-desk-'))
const out = join(dir, 'desk.cjs')
await build({
  stdin: {
    contents: [
      "export * from './src/client/Desk.tsx'",
      "export { CompactBoard } from './src/client/CompactBoard.tsx'",
      "export { RouterBoardController } from './src/client/controller.ts'",
      "export { createMockSource } from './src/client/mock.ts'",
      "export { DICTIONARIES } from './src/client/locales.ts'",
      "export { resolveTheme, THEME_STORAGE_KEY } from './src/client/theme.tsx'",
      "export { BOARD_TOKENS_CSS, UI_THEME } from './src/client/styles.ts'",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  outfile: out,
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/server', '@deepseek-ai/*'],
  logLevel: 'silent',
})
const desk = require(out)
process.on('exit', () => { rmSync(dir, { recursive: true, force: true }) })


const zh = desk.DICTIONARIES.zh
/** The locale lookup the shell does: `{name}` placeholders, key when missing. */
const t = (key, values = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`))

test('failureKey folds paths, numbers, ids and quotes so one cause groups as one', () => {
  const a = desk.failureKey('ffmpeg exited with code 1: /srv/media/in/a.mp4: Invalid data found\nstack…')
  const b = desk.failureKey('ffmpeg exited with code 1: /srv/media/in/other-file.mp4: Invalid data found')
  assert.equal(a, b)
  assert.ok(!a.includes('\n'))
  assert.ok(a.includes('<path>'))
  assert.equal(desk.failureKey('push rejected at 3f9a2c1d'), desk.failureKey('push rejected at 0badc0de12'))
  assert.equal(desk.failureKey('timeout after 30s'), desk.failureKey('timeout after 120s'))
  assert.notEqual(desk.failureKey('timeout after 30s'), desk.failureKey('permission denied'))
  assert.equal(desk.failureKey(undefined), '')
  assert.equal(desk.failureKey('   '), '')
  assert.ok(desk.failureKey('x'.repeat(500)).length <= 80)
})

test('mergeSegments replaces a running segment by seq and keeps order', () => {
  const first = [{ seq: 1, kind: 'command', title: 'ls', body: '', error: false, at: 1 }, { seq: 2, kind: 'command', title: 'make', body: 'a', error: false, at: 2, running: true }]
  const next = desk.mergeSegments(first, [{ seq: 2, kind: 'command', title: 'make', body: 'a\nb', error: true, at: 2 }, { seq: 3, kind: 'end', title: 'done', body: '', error: false, at: 3 }])
  assert.deepEqual(next.map(segment => segment.seq), [1, 2, 3])
  assert.equal(next[1].body, 'a\nb')
  assert.equal(next[1].error, true)
  assert.equal(next[1].running, undefined)
  const many = Array.from({ length: 260 }, (_, index) => ({ seq: index, kind: 'command', title: String(index), body: '', error: false, at: index }))
  assert.equal(desk.mergeSegments([], many).length, 200)
  assert.equal(desk.mergeSegments([], many)[0].seq, 60)
})

test('theme: auto follows the system, a manual choice wins; both palettes exist', () => {
  assert.equal(desk.resolveTheme('auto', 'dark'), 'dark')
  assert.equal(desk.resolveTheme('auto', 'light'), 'light')
  assert.equal(desk.resolveTheme('light', 'dark'), 'light')
  assert.equal(desk.resolveTheme('dark', 'light'), 'dark')
  assert.equal(desk.THEME_STORAGE_KEY, 'dshr.theme')
  for (const mode of ['light', 'dark']) {
    for (const key of ['bg', 'surface', 'raised', 'text', 'accent', 'onAccent', 'line', 'scrim']) {
      assert.match(desk.UI_THEME[mode][key], /\S/, `${mode}.${key}`)
    }
  }
  assert.notEqual(desk.UI_THEME.light.bg, desk.UI_THEME.dark.bg)
  assert.ok(desk.BOARD_TOKENS_CSS.includes('.dshrc[data-theme="dark"]'))
  assert.ok(desk.BOARD_TOKENS_CSS.includes('--c-accent'))
  // No font files and no vendor assets: a system font stack only.
  assert.ok(!/@font-face|url\(/.test(desk.BOARD_TOKENS_CSS))
  assert.ok(!/@font-face|url\(/.test(desk.DESK_CSS))
})

test('every key the desk uses exists in both languages', () => {
  const en = desk.DICTIONARIES.en
  const keys = Object.keys(zh)
  for (const key of keys) assert.ok(key in en, `en is missing ${key}`)
  for (const key of ['ap.title', 'ap.approve', 'ap.confirmApprove', 'live.title', 'live.jump', 'ra.keep', 'ra.fresh',
    'batch.confirm', 'batch.act.cancel', 'batch.act.reassign', 'theme.now', 'theme.auto', 'theme.light', 'theme.dark',
    'row.pr', 'row.movedTo', 'row.movedFrom', 'ap.kind.merge', 'ap.kind.ops', 'ap.kind.git', 'ap.kind.browser']) {
    assert.ok(key in zh, `zh is missing ${key}`)
  }
})

const fresh = async () => {
  const controller = new desk.RouterBoardController(desk.createMockSource())
  await controller.load()
  return controller
}

test('approvals: pending list, approve runs once and leaves the queue', async () => {
  const controller = await fresh()
  assert.equal(controller.canApprove, true)
  const before = await controller.readApprovals()
  const ids = before.pending.map(item => item.id)
  assert.ok(ids.includes('ap-merge41'))
  const merge = before.pending.find(item => item.id === 'ap-merge41')
  assert.equal(merge.kind, 'merge')
  assert.equal(merge.reversible, false)
  const done = await controller.decideApproval('ap-merge41', 'approve')
  assert.notEqual(done.state, 'pending')
  const after = await controller.readApprovals()
  assert.ok(!after.pending.some(item => item.id === 'ap-merge41'))
  assert.ok(after.recent.some(item => item.id === 'ap-merge41'))
  const rejected = await controller.decideApproval('ap-ops7', 'reject', '先别重启')
  assert.equal(rejected.state, 'rejected')
})

test('live output: segments page by seq, errors flagged', async () => {
  const controller = await fresh()
  assert.equal(controller.canReadLive, true)
  const all = await controller.readLive('task-012', -1)
  assert.ok(all.segments.length >= 3)
  assert.ok(all.segments.some(segment => segment.error))
  const last = Math.max(...all.segments.filter(segment => segment.running !== true).map(segment => segment.seq))
  const later = await controller.readLive('task-012', last)
  assert.ok(later.segments.every(segment => segment.seq > last || segment.running === true))
})

test('改派: keep progress to another workspace with a model; the old row links to the new', async () => {
  const controller = await fresh()
  const models = await controller.listModels()
  assert.ok(models.length > 0)
  const target = controller.getSnapshot().board.partitions.find(partition => partition.id !== 'site')?.id
  const out = await controller.reassign({ taskId: 'task-011', partition: target, model: { provider: models[0].provider, model: models[0].model }, keepProgress: true })
  assert.equal(out.from, 'task-011')
  const tasks = controller.getSnapshot().board.tasks
  const old = tasks.find(task => task.id === 'task-011')
  const next = tasks.find(task => task.id === out.to)
  assert.equal(old.reassignedTo, out.to)
  assert.equal(next.reassignedFrom, 'task-011')
  assert.equal(next.model, models[0].model)
})

test('批量: results per task, the board reloads after', async () => {
  const controller = await fresh()
  const res = await controller.batch(['task-011', 'missing-task'], 'retry')
  assert.equal(res.results.length, 2)
  assert.equal(res.ok + res.failed, 2)
  assert.ok(res.results.find(row => row.id === 'missing-task').ok === false)
})

test('first render: theme, batch toggle, PR and 改派 links, row actions', async () => {
  const controller = await fresh()
  const markup = renderToStaticMarkup(React.createElement(desk.CompactBoard, { controller, t }))
  assert.match(markup, /data-theme="(light|dark)"/)
  assert.ok(markup.includes('data-theme-pref="auto"'), 'theme button rendered, default auto')
  assert.ok(markup.includes(t('batch.enter')), 'batch toggle rendered')
  // Rows from every tab are not all on the first tab; the PR row and the moved row are active/resolved.
  const active = markup
  assert.ok(active.includes(t('live.open')), 'a running row offers 输出')
  assert.ok(active.includes(t('ra.reassign')), 'an open row offers 改派')
  assert.ok(active.includes(t('row.movedFrom')), 'the row that took over links back')
  assert.ok(markup.includes('.dshd-live'), 'desk stylesheet is included')
  assert.ok(!markup.includes('class="dshd-scrim"'), 'no dialog until asked')
  assert.ok(!markup.includes('class="dshd-live"'), 'no output panel until asked')
})
