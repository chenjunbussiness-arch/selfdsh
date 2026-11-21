/** Difficulty-tier classification and default routes, against the compiled lib. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyTier, defaultTiers } from '../lib/tier.js'

const models = [
  { provider: 'kiro', providerName: 'kiro', model: 'kiro/claude-opus-5.5', name: 'kiro/claude-opus-5.5' },
  { provider: 'kiro', providerName: 'kiro', model: 'kiro/claude-haiku-5.5', name: 'kiro/claude-haiku-5.5' },
  { provider: 'gemini', providerName: 'Gemini', model: 'gemini-3.1-flash-lite', name: 'gemini-3.1-flash-lite' },
]
const fallback = { provider: 'kiro', model: 'kiro/claude-opus-5.5' }
const tiers = defaultTiers(models, fallback)

const samples = [
  ['列出 /srv/workspace/deepseek-harness/dsh-vpn 目录下的文件数', 'easy'],
  ['给 TokenStats 组件加一个刷新按钮', 'medium'],
  ['重做整个右侧面板并重建验证', 'hard'],
]

test('three samples classify and pick a route', async () => {
  for (const [text, want] of samples) {
    const decision = await classifyTier({ text }, undefined, tiers.easy)
    const route = tiers[decision.tier]
    console.log(`${decision.tier.padEnd(6)} ${decision.source.padEnd(8)} ${route.provider}/${route.model}  <- ${text}  (${decision.reason})`)
    assert.equal(decision.tier, want)
  }
})

test('explicit tier wins, marker works, llm failure falls back to medium', async () => {
  assert.equal((await classifyTier({ text: '列出文件', tier: 'hard' }, undefined, tiers.easy)).tier, 'hard')
  assert.equal((await classifyTier({ text: '[tier:easy] 重构整个仓库' }, undefined, tiers.easy)).tier, 'easy')
  const failing = async () => { throw new Error('boom') }
  const d = await classifyTier({ text: 'hello there' }, failing, tiers.easy)
  assert.equal(d.tier, 'medium'); assert.equal(d.source, 'fallback')
  const ok = async () => 'easy - trivial'
  assert.equal((await classifyTier({ text: 'hello there' }, ok, tiers.easy)).source, 'llm')
})

test('easy default is the cheapest-sounding model', () => {
  assert.deepEqual(tiers.easy, { provider: 'gemini', model: 'gemini-3.1-flash-lite' })
  assert.deepEqual(tiers.hard, fallback)
})

const ruleCases = [
  // read-only viewing vs viewing then modifying
  ['查看改动', 'easy'],
  ['查看一下本次的修改', 'easy'],
  ['查看 diff', 'easy'],
  ['查看改动并修复', 'medium'],
  ['修复登录 bug', 'medium'],
  // "整个" + read-only vs "整个" + refactor / rewrite
  ['看下整个文件有几行', 'easy'],
  ['看一下整个文件有几行', 'easy'],
  ['统计整个目录的文件数', 'easy'],
  ['整个模块重构', 'hard'],
  ['重构整个路由层', 'hard'],
  ['整个文件改写一遍', 'hard'],
]

test('read-only "查看改动" and lone "整个" are not over-graded', async () => {
  for (const [text, want] of ruleCases) {
    const decision = await classifyTier({ text }, undefined, tiers.easy)
    assert.equal(decision.tier, want, `${text} -> ${decision.tier} (${decision.reason})`)
    assert.equal(decision.source, 'rule', text)
  }
})
