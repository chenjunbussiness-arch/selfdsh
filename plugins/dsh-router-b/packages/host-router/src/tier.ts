/**
 * Difficulty tiers: decide how hard a routed task is, then pick the model route
 * its child runs on.
 *
 * Three tiers, `easy | medium | hard`, each bound to one `{provider, model,
 * reasoningEffort?}` route. Order of decision for one task:
 *
 * 1. explicit — `route_task({ tier })` or a `[tier:hard]` marker in the text;
 * 2. rules — read-only / modify / large-change keywords, file count, build+UI;
 * 3. LLM — one short call on the easy-tier route, answering `easy|medium|hard`;
 * 4. fallback — `medium`.
 *
 * The configuration lives in `<boardDir>/tiers.json` and is written by the
 * panel (`POST /api/router/tiers`). Only what the user saved is stored; the
 * defaults are recomputed from the live model list, so a provider added later
 * shows up without a migration.
 *
 * @module host-router/tier
 */

import { readFile, rename, writeFile } from 'node:fs/promises'

/** The three difficulty tiers. */
export type Tier = 'easy' | 'medium' | 'hard'

/** All tiers, cheapest first. */
export const TIERS: readonly Tier[] = ['easy', 'medium', 'hard']

/** One model route. */
export interface TierRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** How the tier of one task was decided. */
export type TierSource = 'explicit' | 'rule' | 'llm' | 'fallback'

/** One classification. */
export interface TierDecision {
  readonly tier: Tier
  readonly source: TierSource
  readonly reason: string
}

/** Persisted user choice. */
export interface TierSettings {
  /** `false` means every task inherits the dispatcher's model (the old behaviour). */
  readonly auto: boolean
  readonly tiers: Partial<Record<Tier, TierRoute>>
}

/** One model offered to the panel. */
export interface ModelOption {
  readonly provider: string
  readonly providerName: string
  readonly model: string
  readonly name: string
  readonly efforts?: readonly string[]
}

/** Is this a tier name? */
export function isTier(value: unknown): value is Tier {
  return value === 'easy' || value === 'medium' || value === 'hard'
}

const TAG = /\[\s*tier\s*[:=]\s*(easy|medium|hard)\s*\]/i

/**
 * Read an explicit `[tier:x]` marker.
 * @param text - task text.
 * @returns the tier, or undefined when no marker is present.
 */
export function tierTagOf(text: string): Tier | undefined {
  const match = TAG.exec(text)
  return match === null ? undefined : match[1]!.toLowerCase() as Tier
}

/** Large-change wording: rebuilds, redesigns, cross-file work, investigations. */
const HARD = /重做|重写|重构|改版|大改|架构|排查|根因|跨文件|多个文件|全部重|迁移|从零|redesign|rewrite|refactor|architect|migrat|investigat|root cause|across files/i
/** Anything that changes files or state. */
const MODIFY = /改|修复|实现|添加|新增|加一个|加个|增加|删除|写入|写一个|创建|部署|安装|重建|构建|编译|\bbuild\b|implement|\badd\b|\bfix\b|\bedit\b|create|delete|remove|install|deploy|write/i
/** Read-only questions: listing, counting, status, statistics. */
const READ_ONLY = /列出|列目录|统计|多少|文件数|几行|查看|查一下|查状态|状态|只读|读取|看看|看下|看一下|有哪些|是否存在|\blist\b|\bcount\b|\bstatus\b|\bshow\b|read-only|readonly|\bls\b|how many/i
/** Viewing changes ("查看改动"): "改动/修改/变更" is the object here, not a request to change. */
const VIEW_CHANGES = /(?:查看|看看|看下|看一下|列出|显示)(?:一下)?(?:本次|这次|当前|最近的?)?(?:的)?(?:改动|修改|变更)/g
/** "整个/全部" alone is just scope ("整个文件有几行"); it is large only with rework wording. */
const WHOLE = /整个|全部/
const REWORK = /改写|改造|重新(?:写|实现|设计)|替换/
/** Building plus a UI change is a hard combination. */
const BUILD = /构建|重建|编译|\bbuild\b|rebuild/i
const UI = /界面|页面|面板|组件|样式|\bui\b|panel|component|css|layout/i

/**
 * Rule-only classification.
 * @param text - task text.
 * @param files - files the task names, when given.
 * @returns a decision, or undefined when the rules cannot tell.
 */
export function classifyByRules(text: string, files: readonly string[] = []): TierDecision | undefined {
  const hard = HARD.exec(text)
  if (hard !== null) return { tier: 'hard', source: 'rule', reason: `large-change wording "${hard[0]}"` }
  const whole = WHOLE.exec(text)
  const rework = REWORK.exec(text)
  if (whole !== null && rework !== null) {
    return { tier: 'hard', source: 'rule', reason: `large-change wording "${whole[0]}…${rework[0]}"` }
  }
  if (files.length >= 3) return { tier: 'hard', source: 'rule', reason: `${String(files.length)} files named` }
  const modify = MODIFY.exec(text.replace(VIEW_CHANGES, ' '))
  if (modify !== null && BUILD.test(text) && UI.test(text)) {
    return { tier: 'hard', source: 'rule', reason: 'UI change plus rebuild' }
  }
  const read = READ_ONLY.exec(text)
  if (modify === null && read !== null) return { tier: 'easy', source: 'rule', reason: `read-only wording "${read[0]}"` }
  if (modify !== null) return { tier: 'medium', source: 'rule', reason: `modifying wording "${modify[0]}"` }
  return undefined
}

/** One LLM call: system + prompt in, text out. */
export type TierModelCall = (route: TierRoute, system: string, prompt: string) => Promise<string>

const LLM_SYSTEM = [
  'You grade how hard a software task is for an AI coding agent.',
  'easy: read-only lookups (list, count, status, simple stats), trivial routing.',
  'medium: a scoped change to one or two files, a small feature, a single fix.',
  'hard: multi-file changes, UI redesigns, architecture or root-cause investigation, rebuild-and-verify work.',
  'Answer with exactly one line: `<easy|medium|hard> - <one short reason>`.',
].join('\n')

/**
 * Full classification: explicit, rules, LLM, fallback.
 * @param input - task text, files, and an explicit tier when given.
 * @param llm - one LLM call on the easy route, or undefined when unavailable.
 * @param easyRoute - the easy-tier route used for the LLM call.
 * @returns the decision; never throws.
 */
export async function classifyTier(
  input: { readonly text: string; readonly files?: readonly string[]; readonly tier?: string },
  llm: TierModelCall | undefined,
  easyRoute: TierRoute | undefined,
): Promise<TierDecision> {
  if (isTier(input.tier)) return { tier: input.tier, source: 'explicit', reason: 'route_task tier argument' }
  const tag = tierTagOf(input.text)
  if (tag !== undefined) return { tier: tag, source: 'explicit', reason: `[tier:${tag}] marker` }
  const ruled = classifyByRules(input.text, input.files)
  if (ruled !== undefined) return ruled
  if (llm !== undefined && easyRoute !== undefined) {
    try {
      const answer = await llm(easyRoute, LLM_SYSTEM, `Task:\n${input.text.slice(0, 4000)}`)
      const match = /\b(easy|medium|hard)\b\s*[-:—]?\s*(.*)/i.exec(answer)
      if (match !== null) {
        return {
          tier: match[1]!.toLowerCase() as Tier,
          source: 'llm',
          reason: (match[2] ?? '').trim().slice(0, 160) || 'llm verdict',
        }
      }
      return { tier: 'medium', source: 'fallback', reason: `llm answer unreadable: ${answer.slice(0, 60)}` }
    } catch (error) {
      return { tier: 'medium', source: 'fallback', reason: `llm classification failed: ${String(error).slice(0, 120)}` }
    }
  }
  return { tier: 'medium', source: 'fallback', reason: 'rules inconclusive, no classifier' }
}

/**
 * Rank a model name by how cheap it sounds. Prices are not published by the
 * providers here, so the name is all there is: lite > mini/nano > flash/haiku.
 */
function cheapness(name: string): number {
  const lower = name.toLowerCase()
  let score = 0
  if (/lite/.test(lower)) score += 4
  if (/mini|nano/.test(lower)) score += 3
  if (/flash|haiku/.test(lower)) score += 2
  return score
}

/**
 * Default routes from the live model list.
 * @param models - every advertised model.
 * @param fallback - the profile default selection.
 * @returns one route per tier.
 */
export function defaultTiers(models: readonly ModelOption[], fallback: TierRoute | undefined): Record<Tier, TierRoute | undefined> {
  let cheapest: ModelOption | undefined
  for (const option of models) {
    const score = cheapness(`${option.model} ${option.name}`)
    if (score > 0 && (cheapest === undefined || score > cheapness(`${cheapest.model} ${cheapest.name}`))) cheapest = option
  }
  return {
    easy: cheapest === undefined ? fallback : { provider: cheapest.provider, model: cheapest.model },
    medium: fallback,
    hard: fallback,
  }
}

/** Durable tier settings in one JSON file. */
export class TierStore {
  private settings: TierSettings = { auto: true, tiers: {} }

  private constructor(private readonly file: string) {}

  /** Open (or start) the settings file. */
  static async open(file: string): Promise<TierStore> {
    const store = new TierStore(file)
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<TierSettings>
      store.settings = normaliseSettings(parsed)
    } catch {
      // Absent or unreadable: defaults apply.
    }
    return store
  }

  /** Current saved settings. */
  get(): TierSettings {
    return this.settings
  }

  /** Replace and persist. */
  async set(next: TierSettings): Promise<TierSettings> {
    this.settings = normaliseSettings(next)
    const temp = `${this.file}.tmp-${String(process.pid)}`
    await writeFile(temp, `${JSON.stringify(this.settings, undefined, 2)}\n`)
    await rename(temp, this.file)
    return this.settings
  }
}

/** Validate a settings document; unknown fields are dropped. */
export function normaliseSettings(raw: Partial<TierSettings> | undefined): TierSettings {
  const tiers: Partial<Record<Tier, TierRoute>> = {}
  for (const tier of TIERS) {
    const route = raw?.tiers?.[tier] as Partial<TierRoute> | undefined
    if (route != null && typeof route.provider === 'string' && route.provider !== ''
      && typeof route.model === 'string' && route.model !== '') {
      tiers[tier] = {
        provider: route.provider,
        model: route.model,
        ...typeof route.reasoningEffort === 'string' && route.reasoningEffort !== '' ? { reasoningEffort: route.reasoningEffort } : {},
      }
    }
  }
  return { auto: raw?.auto !== false, tiers }
}
