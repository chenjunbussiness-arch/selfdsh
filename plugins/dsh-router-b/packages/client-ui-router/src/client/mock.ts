/**
 * Built-in sample board.
 *
 * Purpose: prove the panel's information design without waiting on the Host
 * half, and keep the panel honest when the router bundle is not installed. It is
 * also a live sandbox — publishing a demand and accepting/rejecting a reported
 * task really mutate this snapshot, so the interaction can be demonstrated end
 * to end before any Host code exists.
 *
 * Nothing here is a fallback for real data: `origin: 'mock'` is rendered in the
 * panel header, so a demo is never mistaken for a running router.
 */

import type {
  ApprovalView, LiveSegmentView, ModelChoiceView,
  ArtifactRef, BoardSnapshot, CredentialView, DemandView, ManagerView, PartitionView, PublishResult,
  TaskState, TaskView, TodoItem, WorkerPresence, WorkerView,
} from './contract.ts'
import type { BoardSource } from './source.ts'

/** Minutes-ago helper so the sample always looks live. */
const MINUTE = 60_000
const at = (minutesAgo: number): string => new Date(Date.now() - minutesAgo * MINUTE).toISOString()

const todo = (content: string, status: TodoItem['status']): TodoItem => ({ content, status })

const worker = (
  id: string, name: string, presence: WorkerPresence,
  extra: Partial<Pick<WorkerView, 'sessionId' | 'activity' | 'elapsedSeconds'>> = {},
): WorkerView => ({ id, name, presence, ...extra })

const manager = (
  id: string, name: string, presence: WorkerPresence, dispatched: number, awaitingVerification: number,
): ManagerView => ({ id, name, presence, dispatched, awaitingVerification })

const artifact = (name: string, address: string, bytes?: number): ArtifactRef =>
  ({ name, address, ...(bytes === undefined ? {} : { bytes }) })

/** Sample partitions, in roster order. */
const partitions: PartitionView[] = [
  {
    id: 'rca-ab-test',
    name: 'rca-ab-test',
    repo: 'E:/PythonProject/rca-ab-test',
    manager: manager('mgr-rca', 'manager', 'online', 3, 1),
    workers: [
      worker('w-rca-1', 'worker-1', 'busy', { sessionId: 'ses_rca1', activity: 'go build', elapsedSeconds: 318 }),
      worker('w-rca-2', 'worker-2', 'released', { sessionId: 'ses_rca2' }),
      worker('w-rca-3', 'worker-3', 'released', { sessionId: 'ses_rca3' }),
      worker('w-rca-4', 'worker-4', 'busy', { sessionId: 'ses_rca4', activity: 'pytest -q', elapsedSeconds: 96 }),
    ],
  },
  {
    id: 'deepseek-harness',
    name: 'deepseek-harness',
    repo: 'E:/PythonProject/deepseek-harness-latest',
    manager: manager('mgr-harness', 'manager', 'busy', 5, 0),
    workers: [
      worker('w-h-1', 'worker-1', 'online', { sessionId: 'ses_h1' }),
      worker('w-h-2', 'worker-2', 'offline', { sessionId: 'ses_h2' }),
      worker('w-h-3', 'worker-3', 'busy', { sessionId: 'ses_h3', activity: 'tsc -b', elapsedSeconds: 44 }),
    ],
  },
  {
    id: 'slidecraft',
    name: 'slidecraft',
    repo: 'E:/PythonProject/slidecraft',
    // The sample keeps one partition switched off so the rail's control and its
    // muted row are visible without a Host that implements the switch.
    enabled: false,
    manager: manager('mgr-slide', 'manager', 'online', 1, 0),
    workers: [
      worker('w-s-1', 'worker-1', 'online', { sessionId: 'ses_s1' }),
      worker('w-s-2', 'worker-2', 'released', { sessionId: 'ses_s2' }),
    ],
  },
]

/**
 * Sample credential status.
 *
 * Deliberately NOT a model allow-list: the board only repeats what
 * `ctx.credentials.describe` answers, and these two rows are what such an answer
 * looks like — one stored, one absent, neither carrying a value.
 */
const credentials: CredentialView[] = [
  { ref: 'DEEPSEEK_API_KEY', label: 'DeepSeek', configured: true, source: 'file', writable: true },
  { ref: 'GLM_API_KEY', label: 'GLM', configured: false, source: 'unset', writable: true },
]

/** Sample tasks. One per interesting state, including a rejection. */
const seedTasks = (): TaskView[] => [
  {
    id: 'task-001',
    title: '把 go build 的失败用例收敛掉',
    partitionId: 'rca-ab-test',
    workerId: 'w-rca-1',
    state: 'running',
    requestedAt: at(38),
    updatedAt: at(2),
    attempt: 1,
    workerSessionId: 'ses_rca1',
    todos: [
      todo('读 rca-state 的 build 报错', 'completed'),
      todo('定位 vendor 里缺失的符号', 'completed'),
      todo('改 internal/mcpserver/registry.json', 'completed'),
      todo('跑 go build ./...', 'in_progress'),
      todo('跑 go vet ./...', 'pending'),
      todo('补一条回归单测', 'pending'),
      todo('写任务记录 task.md', 'pending'),
    ],
  },
  {
    id: 'task-002',
    title: 'SSE 断流后前端不重连',
    partitionId: 'rca-ab-test',
    workerId: 'w-rca-4',
    state: 'running',
    requestedAt: at(22),
    updatedAt: at(1),
    attempt: 1,
    workerSessionId: 'ses_rca4',
    todos: [
      todo('复现断流：kill 掉 agent 进程', 'completed'),
      todo('看 rca-front 的 EventSource 封装', 'completed'),
      todo('加 5s 指数退避重连', 'in_progress'),
      todo('补一条 e2e', 'pending'),
      todo('跑 npm run build', 'pending'),
    ],
  },
  {
    id: 'task-003',
    title: '补 registry.json 的 12 个工具描述',
    partitionId: 'rca-ab-test',
    workerId: 'w-rca-2',
    state: 'reported',
    requestedAt: at(95),
    updatedAt: at(6),
    reportedAt: at(6),
    attempt: 1,
    workerSessionId: 'ses_rca2',
    todos: [
      todo('列出 12 个 canonical 工具名', 'completed'),
      todo('按 . -> _ 映射校对 agent 侧', 'completed'),
      todo('写描述并校验 JSON', 'completed'),
      todo('跑 /api/mcp/{atom,flow} 冒烟', 'completed'),
      todo('自检通过，交 manager 验收', 'completed'),
    ],
    artifacts: [artifact('registry.json', 'dsh-resource://file/session/ses_rca2/registry.json', 18_420)],
  },
  {
    id: 'task-004',
    title: 'client 插件加载失败时要有可见错误',
    partitionId: 'deepseek-harness',
    workerId: 'w-h-3',
    state: 'verified',
    requestedAt: at(180),
    updatedAt: at(31),
    reportedAt: at(48),
    verifiedAt: at(31),
    attempt: 1,
    workerSessionId: 'ses_h3',
    todos: [
      todo('读 dsh-client-modules 的 loader', 'completed'),
      todo('把 slot entry crash 冒到 UI', 'completed'),
      todo('加一层错误边界', 'completed'),
      todo('截图验证', 'completed'),
    ],
    artifacts: [artifact('slot-crash.png', 'dsh-resource://file/session/ses_h3/shots/slot-crash.png', 84_112)],
  },
  {
    id: 'task-005',
    title: 'session 列表在冷启动时闪空',
    partitionId: 'deepseek-harness',
    state: 'queued',
    requestedAt: at(3),
    updatedAt: at(3),
    attempt: 1,
    todos: [],
  },
  {
    id: 'task-006',
    title: '导出 PPT 时字体回退到 Helvetica',
    partitionId: 'slidecraft',
    workerId: 'w-s-1',
    state: 'rejected',
    requestedAt: at(140),
    updatedAt: at(12),
    reportedAt: at(25),
    attempt: 2,
    workerSessionId: 'ses_s1',
    rejectionReason: '验收未通过：第 3、7 页仍回退到 Helvetica，未嵌入 Montserrat',
    todos: [
      todo('找出模板里的字体声明', 'completed'),
      todo('换成 Montserrat 并嵌入子集', 'completed'),
      todo('重新导出 PPT 并逐页比对', 'in_progress'),
      todo('把 6 处回退清掉', 'pending'),
    ],
  },
  {
    // Deferred work: queued, but waiting on the clock rather than on a worker,
    // so it is listed under 排程 and not under 待派.
    id: 'task-007',
    title: '把 rca-state 的回归单测并进 CI',
    partitionId: 'rca-ab-test',
    state: 'queued',
    requestedAt: at(9),
    updatedAt: at(9),
    scheduledFor: at(-95),
    attempt: 1,
    todos: [],
  },
]

/** Ops-flavoured rows: a PR waiting to merge, a failed transcode, and a 改派 pair. */
const deskTasks = (): TaskView[] => [
  {
    id: 'task-010',
    title: '给站点加订阅页并开 PR',
    partitionId: 'deepseek-harness',
    state: 'reported',
    hostState: 'reported',
    requestedAt: at(70),
    updatedAt: at(6),
    reportedAt: at(6),
    attempt: 1,
    pr: { number: 41, url: 'https://code.example/site/web/pull/41', provider: 'github' },
    todos: [],
  },
  {
    id: 'task-011',
    title: '把本周视频转码成 webm 并截封面',
    partitionId: 'slidecraft',
    state: 'rejected',
    hostState: 'failed',
    requestedAt: at(55),
    updatedAt: at(12),
    attempt: 1,
    error: 'ffmpeg: codec not found (libvpx-vp9)',
    todos: [],
  },
  {
    id: 'task-012',
    title: '续签 nginx 证书并重载',
    partitionId: 'rca-ab-test',
    state: 'running',
    hostState: 'running',
    requestedAt: at(9),
    updatedAt: at(1),
    attempt: 1,
    workerSessionId: 'ses_ops1',
    model: 'claude-opus-5.5',
    reassignedFrom: 'task-009',
    todos: [todo('certbot renew --dry-run', 'completed'), todo('nginx -t', 'in_progress'), todo('systemctl reload nginx', 'pending')],
  },
  {
    id: 'task-009',
    title: '续签 nginx 证书并重载',
    partitionId: 'deepseek-harness',
    state: 'rejected',
    hostState: 'cancelled',
    requestedAt: at(30),
    updatedAt: at(10),
    attempt: 1,
    reassignedTo: 'task-012',
    error: '改派：这台机器上没有 certbot',
    todos: [],
  },
]

const seedApprovals = (): ApprovalView[] => [
  {
    id: 'ap-merge41', kind: 'merge', partition: 'deepseek-harness', taskId: 'task-010',
    action: '合并 PR #41「给站点加订阅页」到 main（squash）', target: 'https://code.example/site/web/pull/41',
    reason: '页面和表单校验都做完了，本地截图检查过\nCI：success', reversible: false, state: 'pending', createdAt: at(5),
  },
  {
    id: 'ap-ops7', kind: 'ops', partition: 'rca-ab-test', taskId: 'task-012',
    action: '危险命令', target: 'systemctl restart nginx',
    reason: 'reload 后旧 worker 没退出，需要重启一次让新证书生效', reversible: false, state: 'pending', createdAt: at(1),
  },
]

const seedRecent = (): ApprovalView[] => [
  {
    id: 'ap-ops6', kind: 'ops', partition: 'rca-ab-test', taskId: 'task-012',
    action: '变更命令', target: 'certbot renew --cert-name example.com', reason: '证书 9 天后到期',
    reversible: true, state: 'done', createdAt: at(8), decidedAt: at(7), result: 'exit 0\nCongratulations, all renewals succeeded',
  },
]

const liveSample = (): LiveSegmentView[] => {
  const now = Date.now()
  return [
    { seq: 3, kind: 'message', title: 'assistant', body: '先 dry-run 确认证书能续上，再检查 nginx 配置。', error: false, at: now - 300_000 },
    { seq: 4, kind: 'command', title: 'ops_run: certbot renew --dry-run', body: 'Simulating renewal of an existing certificate for example.com\nCongratulations, all simulated renewals succeeded', error: false, at: now - 280_000 },
    { seq: 6, kind: 'command', title: 'ops_run: nginx -t', body: 'nginx: [emerg] unknown directive "ssl_stapling_verifyy" in /etc/nginx/conf.d/site.conf:21\nnginx: configuration file /etc/nginx/nginx.conf test failed', error: true, at: now - 120_000 },
    { seq: 8, kind: 'command', title: 'edit: /etc/nginx/conf.d/site.conf', body: '- ssl_stapling_verifyy on;\n+ ssl_stapling_verify on;', error: false, at: now - 60_000 },
    { seq: 10, kind: 'command', title: 'ops_run: nginx -t', body: '', error: false, at: now - 5_000, running: true },
  ]
}

const sampleModels: ModelChoiceView[] = [
  { provider: 'kiro', providerName: 'Kiro', model: 'claude-opus-5.5', name: 'Claude Opus 5.5', efforts: ['high', 'max'] },
  { provider: 'kiro', providerName: 'Kiro', model: 'claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
  { provider: 'deepseek', providerName: 'DeepSeek', model: 'deepseek-chat', name: 'DeepSeek Chat' },
]

/** Sample demands; one is still waiting for routing. */
const seedDemands = (): DemandView[] => [
  {
    id: 'dmd-001',
    text: '把 HMR 接收器在 dev:web 未启动时的报错变清楚',
    publishedAt: at(4),
    taskIds: [],
  },
  {
    id: 'dmd-002',
    text: 'session 列表在冷启动时闪空',
    publishedAt: at(3),
    partitionId: 'deepseek-harness',
    routingReason: '命中分区关键词 session / list',
    taskIds: ['task-005'],
  },
]

/** Keyword router used by the sample source, so publishing shows a real decision. */
function routeMock(text: string): { partitionId: string; reason: string } {
  const lower = text.toLowerCase()
  if (/rca|registry|go build|sse|atom|flow|mcp/.test(lower)) {
    return { partitionId: 'rca-ab-test', reason: '命中分区关键词 rca / go / mcp' }
  }
  if (/harness|plugin|plugin|client|slot|session|hmr|整理|插件/.test(lower)) {
    return { partitionId: 'deepseek-harness', reason: '命中分区关键词 harness / plugin / session' }
  }
  return { partitionId: 'slidecraft', reason: '默认落到内容产出分区' }
}

const LANE_OF: Record<TaskState, string> = {
  queued: 'queued', running: 'running', reported: 'reported', verified: 'verified', rejected: 'queued',
}

/**
 * Build the in-memory sample source.
 * @returns a BoardSource backed by module state, safe to publish and verify against.
 */
export function createMockSource(): BoardSource {
  let tasks = [...seedTasks(), ...deskTasks()]
  let demands = seedDemands()
  let approvals = seedApprovals()
  let recent = seedRecent()

  const snapshot = (): BoardSnapshot => ({
    fetchedAt: new Date().toISOString(),
    partitions,
    tasks,
    demands,
    origin: 'mock',
    credentials,
  })

  return {
    origin: 'mock',
    async read() {
      return snapshot()
    },
    async publish(texts): Promise<PublishResult> {
      const now = new Date().toISOString()
      const routed: PublishResult['routed'][number][] = []
      for (const raw of texts) {
        const text = raw.trim()
        if (text === '') continue
        const { partitionId, reason } = routeMock(text)
        const taskId = `task-${String(tasks.length + 1).padStart(3, '0')}`
        tasks = [{
          id: taskId,
          title: text.length > 42 ? `${text.slice(0, 42)}…` : text,
          partitionId,
          state: 'queued',
          requestedAt: now,
          updatedAt: now,
          attempt: 1,
          todos: [],
        }, ...tasks]
        const demand: DemandView = {
          id: `dmd-${String(demands.length + 1).padStart(3, '0')}`,
          text,
          publishedAt: now,
          partitionId,
          routingReason: reason,
          taskIds: [taskId],
        }
        demands = [demand, ...demands]
        routed.push({ text, partitionId, reason })
      }
      return { accepted: routed.length, routed }
    },
    async verify(taskId, verdict, note) {
      tasks = tasks.map((task) => {
        if (task.id !== taskId) return task
        const now = new Date().toISOString()
        return verdict === 'verified'
          ? { ...task, state: 'verified' as const, verifiedAt: now, updatedAt: now }
          : {
              ...task,
              state: 'rejected' as const,
              updatedAt: now,
              rejectionReason: note ?? '验收未通过',
              attempt: (task.attempt ?? 1) + 1,
            }
      })
    },
    async control(taskId, action) {
      if (action !== 'resume') return
      tasks = tasks.map(task => task.id !== taskId ? task : {
        ...task, state: 'running' as const, hostState: 'running' as const, resumeNote: undefined, updatedAt: new Date().toISOString(),
      })
    },
    async readApprovals() {
      return { pending: approvals, recent }
    },
    async decideApproval(id, decision, note) {
      const item = approvals.find(entry => entry.id === id)
      if (item === undefined) throw new Error(`unknown approval "${id}"`)
      const decided: ApprovalView = {
        ...item, decidedAt: new Date().toISOString(), ...(note === undefined ? {} : { note }),
        ...(decision === 'approve' ? { state: 'done' as const, result: '（示例数据）已执行' } : { state: 'rejected' as const }),
      }
      approvals = approvals.filter(entry => entry.id !== id)
      recent = [decided, ...recent]
      return decided
    },
    async readAudit() {
      return []
    },
    async readLive(taskId, after = -1) {
      const task = tasks.find(entry => entry.id === taskId)
      const segments = task?.state === 'running' ? liveSample() : []
      return { taskId, state: task?.hostState ?? task?.state ?? 'unknown', at: Date.now(), segments: segments.filter(segment => segment.seq > after || segment.running === true) }
    },
    async listModels() {
      return sampleModels
    },
    async reassign(input) {
      const old = tasks.find(entry => entry.id === input.taskId)
      if (old === undefined) throw new Error(`unknown task "${input.taskId}"`)
      const to = `task-${String(tasks.length + 1).padStart(3, '0')}`
      const now = new Date().toISOString()
      const partitionId = input.partition ?? old.partitionId
      tasks = [
        { ...old, id: to, partitionId, state: 'queued', hostState: 'queued', updatedAt: now, requestedAt: now, reassignedFrom: old.id, reassignedTo: undefined, error: undefined, ...(input.model === undefined ? {} : { model: input.model.model }) },
        ...tasks.map(entry => entry.id !== old.id ? entry : { ...entry, reassignedTo: to, state: 'rejected' as const, hostState: 'cancelled' as const }),
      ]
      return { from: old.id, to, partition: partitionId, text: `reassigned ${old.id} -> ${to}` }
    },
    async batch(taskIds, action) {
      const results = taskIds.map((id) => {
        const found = tasks.some(entry => entry.id === id)
        return found ? { id, ok: true, state: action } : { id, ok: false, error: `unknown task "${id}"` }
      })
      if (action === 'cancel' || action === 'cancel_tree') {
        tasks = tasks.map(entry => !taskIds.includes(entry.id) ? entry : { ...entry, state: 'rejected' as const, hostState: 'cancelled' as const })
      }
      return { ok: results.filter(entry => entry.ok).length, failed: results.filter(entry => !entry.ok).length, results }
    },
    subscribe() {
      return () => {}
    },
  }
}

/** Lane a task is rendered in; exposed for the store's counts. */
export function laneOf(state: TaskState): string {
  return LANE_OF[state]
}
