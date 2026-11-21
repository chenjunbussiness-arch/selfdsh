import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { TaskBoard } from '../lib/board.js'
const b = await TaskBoard.open(await mkdtemp(join(tmpdir(), 'rb-')), 'run-x')
const now = new Date().toISOString()
for (let i = 0; i < 3; i++) await b.add({ id: 't' + i, partition: 'p', subject: 's', body: 'b', state: 'queued', cwd: '/', priority: 0, level: 'worker', reason: 'explicit', because: [], attempts: 0, createdAt: now, updatedAt: now })
await Promise.all([0, 1, 2].map(i => b.patch('t' + i, { state: 'cancelled' })))
assert.deepEqual(b.list().map(t => t.state), ['cancelled', 'cancelled', 'cancelled'])
console.log('ok concurrent patches (3 parallel) no ENOENT')
