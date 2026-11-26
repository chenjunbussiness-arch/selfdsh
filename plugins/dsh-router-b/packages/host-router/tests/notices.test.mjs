// 【进度提醒】 merging: one queued notice, the latest line per subject.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ASK_FOOTER, isAskLine, mergeNoticeLines, noticeLinesOf, noticeSubject, noticeText } from '../lib/notices.js'

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

test('a question is not wiped out by later progress about the same task', () => {
  const ask = '「接口改造」（quick） 需要回答：用 v1 还是 v2 的字段名？'
  const later = '「接口改造」（quick） 进度：读完了 schema'
  assert.equal(isAskLine(ask), true)
  assert.equal(isAskLine(later), false)
  assert.deepEqual(mergeNoticeLines([ask], [later]), [ask, later])
  // A newer question replaces the older one; finishing the task drops it.
  const ask2 = '「接口改造」（quick） 卡住了：没有数据库密码'
  assert.deepEqual(mergeNoticeLines([ask, later], [ask2]), [later, ask2])
  assert.deepEqual(mergeNoticeLines([ask, later], ['「接口改造」（quick） 完成：好了']), ['「接口改造」（quick） 完成：好了'])
  // Router lines: a block question stays beside the stall note and the progress.
  const block = '任务 t7（迁移）需要你决定：要不要先备份？已暂停'
  assert.deepEqual(mergeNoticeLines([block], ['任务 t7（迁移）已挂起：等前置']), [block, '任务 t7（迁移）已挂起：等前置'])
})

test('questions are never folded away, and a notice with one says how to treat it', () => {
  const asks = ['「a」 需要回答：x', '「b」 卡住了：y']
  const progress = Array.from({ length: 20 }, (_, i) => `「p${String(i)}」 进度：${String(i)}`)
  const merged = mergeNoticeLines([...asks, ...progress], [], 5)
  for (const ask of asks) assert.ok(merged.includes(ask))
  assert.equal(merged.length, 6)
  assert.match(merged[0], /另有 17 条/)
  const text = noticeText(merged)
  assert.ok(text.endsWith(ASK_FOOTER))
  assert.equal(noticeText(['「p」 进度：1']).includes(ASK_FOOTER), false)
  // The footer is not read back as a line.
  assert.deepEqual(noticeLinesOf(msg(noticeText(asks))), asks)
})
