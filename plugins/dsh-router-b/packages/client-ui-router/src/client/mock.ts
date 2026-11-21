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
  let tasks = seedTasks()
  let demands = seedDemands()

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
    subscribe() {
      return () => {}
    },
  }
}

/** Lane a task is rendered in; exposed for the store's counts. */
export function laneOf(state: TaskState): string {
  return LANE_OF[state]
}
