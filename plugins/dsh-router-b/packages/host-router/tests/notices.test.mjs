// 【进度提醒】 merging: one queued notice, the latest line per subject.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mergeNoticeLines, noticeLinesOf, noticeSubject, noticeText } from '../lib/notices.js'

const msg = text => ({ id: 'm', role: 'user', content: [{ type: 'text', text }] })

test('noticeLinesOf reads only 【进度提醒】 messages', () => {
  assert.deepEqual(noticeLinesOf(msg(noticeText(['a', 'b']))), ['a', 'b'])
  assert.equal(noticeLinesOf(msg('帮我看看日志')), undefined)
  assert.equal(noticeLinesOf({ role: 'assistant', content: [{ type: 'text', text: noticeText(['a']) }] }), undefined)
})

test('subjects: cloud task lines by title and agent, router lines by task id', () => {
  assert.equal(noticeSubject('「P7 收口」（quick-ws） 进度：测试已 7/7 通过'), '「P7 收口」（quick-ws）')
  assert.equal(noticeSubject('「P7 收口」（quick-ws） 完成：好了'), '「P7 收口」（quick-ws）')
  assert.equal(noticeSubject('云端新任务 「P7 收口」（quick-ws）'), '「P7 收口」（quick-ws）')
  assert.equal(noticeSubject('dsh-cloud（web） 在本地开始 「备份」'), '「备份」')
  assert.equal(noticeSubject('任务 t12（改样式）已挂起：等前置'), 'task:t12')
  assert.equal(noticeSubject('挂起的任务 t12（改样式）已手动继续。'), 'task:t12')
})

test('51 queued copies of one line become one; the latest state of each task wins', () => {
  const line = '「P7 收口：记录风险等级」（quick-ws） 进度：测试已 7/7 通过'
  const queued = Array.from({ length: 51 }, () => line)
  assert.deepEqual(mergeNoticeLines(queued, [line]), [line])
  const merged = mergeNoticeLines([line, '「备份」（ops） 进度：一半'], ['「P7 收口：记录风险等级」（quick-ws） 完成：好了'])
  assert.deepEqual(merged, ['「备份」（ops） 进度：一半', '「P7 收口：记录风险等级」（quick-ws） 完成：好了'])
})

test('at most max lines, the rest counted', () => {
  const lines = Array.from({ length: 15 }, (_, i) => `「t${String(i)}」 完成`)
  const out = mergeNoticeLines([], lines, 12)
  assert.equal(out.length, 13)
  assert.equal(out[0], '（另有 3 条较早的提醒已合并）')
  assert.equal(out.at(-1), '「t14」 完成')
  // The count line is not carried into the next merge as a subject of its own.
  assert.ok(!noticeLinesOf(msg(noticeText(out))).some(l => l.startsWith('（另有')))
})
