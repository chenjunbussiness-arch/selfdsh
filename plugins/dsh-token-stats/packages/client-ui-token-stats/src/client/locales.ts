/**
 * Panel copy, zh and en. Registered through `ctx.locale.register`; `{name}` is
 * the shell's interpolation syntax.
 */

/** Locale namespace id. */
export const NS = 'tokenStats'

/** Dictionary keys in one place, so typo drift is obvious. */
export const zh = {
  'today.short': '今日',
  'spark.title': '近 7 天走势',
  'split.input': '新输入',
  'split.cache': '缓存读',
  'split.output': '输出',
  'split.calls': '调用次数',
  'range.today': '今日',
  'hero.note': '{range}合计 · 含缓存读 · 更新于 {time}',
  'empty.range': '这段时间没有用量',
  'daily.title7': '每日用量（近 7 天，按模型着色）',
  'daily.title30': '每日用量（近 30 天，按模型着色）',
  'refresh': '立即刷新',
  'title': 'Token 用量',
  'unit': 'tok',
  'today.label': '今日总量',
  'today.note': '含缓存读 · 截至 {time}',
  'models.title': '按模型',
  'daily.title': '每日汇总',
  'range.7': '近 7 天',
  'range.30': '近 30 天',
  'close': '关闭',
  'loading': '正在统计…',
  'error.short': '统计服务不可用',
  'error.title': '读不到用量统计',
  'error.hint': '宿主侧的只读聚合接口没有响应。页面其余部分不受影响。',
  'retry': '重试',
  'empty.short': '暂无用量数据',
  'empty.title': '暂无用量数据',
  'empty.hint': '运行一次会话后，这里会显示真实 token 消耗（按模型、按天）。',
  'foot.scope': '数据来自本机 ~/.dsh 会话日志，按 UTC+8 分天；总量 = 新输入 + 缓存读 + 输出',
  'foot.scan': '扫描 {files} 个会话 · {events} 条用量事件 · 首扫 {cold} ms · 最近刷新 {warm} ms',
  'foot.updated': '更新于 {time} · 扫描 {files} 个会话、{events} 次调用',
  'value.none': '—',
  'hint.cache': '含缓存读',
  'aria.open': '展开 token 用量统计',
  'aria.close': '收起 token 用量统计',
} as const

/** English mirror of {@link zh}. */
export const en = {
  'today.short': 'today',
  'spark.title': 'Last 7 days',
  'split.input': 'fresh in',
  'split.cache': 'cache read',
  'split.output': 'output',
  'split.calls': 'calls',
  'range.today': 'Today',
  'hero.note': '{range} total · incl. cache reads · updated {time}',
  'empty.range': 'No usage in this range',
  'daily.title7': 'Daily usage (7 days, coloured by model)',
  'daily.title30': 'Daily usage (30 days, coloured by model)',
  'refresh': 'Refresh now',
  'title': 'Token usage',
  'unit': 'tok',
  'today.label': 'Today',
  'today.note': 'incl. cache reads · as of {time}',
  'models.title': 'By model',
  'daily.title': 'Daily totals',
  'range.7': 'Last 7 days',
  'range.30': 'Last 30 days',
  'close': 'Close',
  'loading': 'Aggregating…',
  'error.short': 'Stats service unavailable',
  'error.title': 'Usage stats are unreachable',
  'error.hint': 'The host-side read-only aggregation route did not answer. The rest of the page is unaffected.',
  'retry': 'Retry',
  'empty.short': 'No usage data yet',
  'empty.title': 'No usage data yet',
  'empty.hint': 'Run a session and its real token usage shows up here, by model and by day.',
  'foot.scope': 'Local ~/.dsh session logs only · time zone UTC+8',
  'foot.scan': 'Scanned {files} sessions · {events} usage events · cold {cold} ms · last refresh {warm} ms',
  'foot.updated': 'Updated {time} · {files} sessions, {events} calls scanned',
  'value.none': '—',
  'hint.cache': 'incl. cache reads',
  'aria.open': 'Expand token usage statistics',
  'aria.close': 'Collapse token usage statistics',
} as const

/** Dictionaries passed to the locale service. */
export const DICTIONARIES = { zh, en: { ...en } }

/** One translate function bound to {@link NS}. */
export type Translate = (key: string, values?: Record<string, string | number>) => string
