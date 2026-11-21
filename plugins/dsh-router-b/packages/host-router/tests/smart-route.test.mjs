import assert from 'node:assert/strict'
import { normalisePartitions, resolveRoute, resolveRouteSmart, parseClassifierOutput, directoryKeywords } from '../lib/config.js'
const root = process.platform === 'win32' ? 'C:\\w\\' : '/w/'
const parts = normalisePartitions([
  { name: 'rca-ab-test', root: root + 'rca', keywords: ['rca', 'jiuwen'], description: 'RCA platform', workers: 0 },
  { name: 'google-tend', root: root + 'google tend', keywords: ['seo'], description: 'tool sites' },
  { name: 'deepseek-harness', root: root + 'dsh', keywords: ['dsh', 'egress'], description: 'DSH plugins', workers: 0 },
], { workers: 2, manager: true })
// 0 = unlimited is accepted; default still 2; negative rejected
assert.equal(parts[0].slots, 0); assert.equal(parts[1].slots, 2)
assert.throws(() => normalisePartitions([{ name: 'x', root: root + 'x', workers: -1 }], { workers: 2, manager: true }), /workers >= 0/)
console.log('ok normalise 0=unlimited')
// explicit
let d = await resolveRouteSmart(parts, { text: 'whatever', partition: 'google-tend' })
assert.equal(d.partition.name, 'google-tend'); assert.equal(d.reason, 'explicit'); console.log('ok explicit')
// keyword unique hit >= threshold (2 keywords = 4) and classifier must not be called
let called = 0
const fake = (answer) => async () => { called++; return answer }
d = await resolveRouteSmart(parts, { text: 'fix the dsh egress panel' }, { classifier: fake('{}') })
assert.equal(d.partition.name, 'deepseek-harness'); assert.equal(d.reason, 'auto'); assert.equal(called, 0); console.log('ok keyword unique')
// zero score -> LLM
d = await resolveRouteSmart(parts, { text: '???????????' }, { classifier: fake('```json\n{"partition":"google-tend","confidence":0.9,"reason":"passport tool"}\n```') })
assert.equal(d.partition.name, 'google-tend'); assert.equal(d.reason, 'llm'); assert.match(d.because[0], /passport tool/); console.log('ok zero-score -> llm', d.because)
// tie -> LLM
d = await resolveRouteSmart(parts, { text: 'rca seo' }, { classifier: fake('{"partition":"rca-ab-test","confidence":0.7,"reason":"r"}') })
assert.equal(d.reason, 'llm'); console.log('ok tie -> llm')
// low confidence -> fallback error includes reason
await assert.rejects(resolveRouteSmart(parts, { text: 'hello' }, { classifier: fake('{"partition":"none","confidence":0.1,"reason":"no idea"}') }), /no partition matched.*LLM classifier answered "none"/)
// invalid output
await assert.rejects(resolveRouteSmart(parts, { text: 'hello' }, { classifier: fake('{"partition":"bogus","confidence":1}') }), /unknown partition "bogus"/)
// timeout
await assert.rejects(resolveRouteSmart(parts, { text: 'hello' }, { classifier: () => new Promise(() => {}), timeoutMs: 50 }), /timed out after 50 ms/)
// no classifier: low single keyword falls back to keyword rule
d = await resolveRouteSmart(parts, { text: 'seo stuff' })
assert.equal(d.partition.name, 'google-tend'); assert.equal(d.reason, 'auto'); assert.match(d.because.at(-1), /unavailable/)
console.log('ok fallbacks (low-confidence, invalid, timeout, unavailable)')
// dir keywords
assert.deepEqual(directoryKeywords(['docs', 'passport-photo-rules', '_tmp', 'rca-front']), ['passport-photo-rules', 'rca-front'])
d = await resolveRouteSmart(parts, { text: 'look in passport-photo-rules and bgr-demo' }, { topDirs: { 'google-tend': ['passport-photo-rules', 'bgr-demo'] } })
assert.equal(d.partition.name, 'google-tend'); assert.equal(d.reason, 'auto'); console.log('ok dir keywords')
// old sync resolveRoute unchanged
assert.throws(() => resolveRoute(parts, { text: 'nothing' }), /no partition matched/)
assert.throws(() => parseClassifierOutput('no json', parts), /no JSON/)
console.log('ALL PASS')
