/** Shape of `GET /api/token-stats/summary` (mirrors host-token-stats/scanner.js `#render`). */

/** The four disjoint provider buckets plus their billed sum. */
export interface Buckets {
  billed: number
  uncachedInput: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** One Asia/Shanghai calendar day. */
export interface DaySummary extends Buckets {
  date: string
  events: number
  models: Record<string, number>
}

/** One model's total and its share of today. */
export interface ModelSummary {
  model: string
  total: number
  today: number
  share: number
}

/** What the aggregator did for the last request. */
export interface Performance {
  requests: number
  scans: number
  cacheHits: number
  firstScanMs: number | null
  lastScanMs: number | null
  servedFromCache: boolean
  cacheAgeMs: number
  lastRefresh: {
    files: number
    reparsed: number
    reused: number
    failed: number
    statMs: number
    parseMs: number
    totalMs: number
  } | null
}

/** The whole document. */
export interface Summary {
  generatedAt: string
  timeZone: string
  source: {
    sessionsDir: string
    sessionFiles: number
    sessionFilesFailed: number
    usageEvents: number
    firstUsageAt: string | null
    lastUsageAt: string | null
  }
  totals: Buckets
  today: Buckets & { date: string; events: number }
  models: ModelSummary[]
  days: DaySummary[]
  performance: Performance
}
