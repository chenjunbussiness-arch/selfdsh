// The worker and 快任务 briefs, read straight from config.js with POSIX paths
// so they run on any machine (router.test.mjs uses Windows roots).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { partitionBrief } from '../lib/config.js'

const web = { name: 'web', root: '/work/web', dir: '/work/web', verify: ['npm test'] }

test('the worker brief names the acceptance commands but leaves running them to the router', () => {
  const brief = partitionBrief(web, { verify: true, taskId: 't1' })
  assert.match(brief, /router runs these acceptance commands once/)
  assert.match(brief, /npm test/)
  assert.doesNotMatch(brief, /Run them yourself/)
  assert.doesNotMatch(partitionBrief(web, { verify: false }), /acceptance/)
})

test('the worker brief asks for targeted tests and no up-front probing', () => {
  const brief = partitionBrief(web, { verify: false })
  assert.match(brief, /Run only the tests that cover what you changed/)
  assert.match(brief, /Do not probe the environment/)
  assert.match(brief, /three or more steps/)
  assert.match(brief, /--- report ---/)
})

test('server script paths come only from the router config', () => {
  const bare = partitionBrief(web, { verify: false })
  assert.doesNotMatch(bare, /\/srv\//, 'no machine path when nothing is configured')
  assert.doesNotMatch(bare, /safe-build|safe-restart|bin\/screenshot/)
  assert.match(bare, /browser_capture/)
  const named = partitionBrief(web, { verify: false, hostScripts: { build: '/opt/b.sh', restart: '/opt/r.sh' } })
  assert.match(named, /`\/opt\/b\.sh`/)
  assert.match(named, /the human runs `\/opt\/r\.sh`/)
  const buildOnly = partitionBrief(web, { verify: false, hostScripts: { build: '/opt/b.sh' } })
  assert.doesNotMatch(buildOnly, /the human runs/)
})

test('the briefs stay short', () => {
  const full = partitionBrief({ ...web, network: 'internet', git: { branch: 'dev', scm: { provider: 'github', repo: 'o/r' } } }, { verify: true, taskId: 't1' })
  assert.ok(full.length < 2300, `worker brief is ${String(full.length)} chars`)
  const quick = partitionBrief({ name: 'quick', root: '/tmp/q', dir: '/tmp/q', quick: true }, { verify: false, taskId: 't2' })
  assert.ok(quick.length < 1000, `快任务 brief is ${String(quick.length)} chars`)
  assert.match(quick, /快任务/)
  assert.doesNotMatch(quick, /todo_write` checklist/)
})
