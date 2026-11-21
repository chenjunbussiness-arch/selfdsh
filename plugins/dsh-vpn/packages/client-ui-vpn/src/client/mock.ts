/**
 * Built-in sample data, used when the host bridge has never answered and by the
 * preview. Always shown with the "sample data" badge.
 *
 * It is interactive on purpose (the preview needs it), but nothing here touches
 * a network: "connect" walks the same states with timers.
 */

import type { LogLine, ProfileInput, ProfileView, StatusView, VpnSnapshot, VpnState } from './contract.ts'
import type { VpnSource } from './source.ts'

/** Scenario the mock starts in. */
export type Scenario = VpnState

const MIN = 60_000

/** Sample profiles: one of each shipped type. */
function sampleProfiles(now: number): ProfileView[] {
  const day = 24 * 60 * MIN
  return [
    {
      id: 'p-1a2b3c4d', name: '公司内网 git', type: 'password', host: 'vpn.corp.example', port: 443, username: 'zhanglei',
      realm: '', trustedCert: '', targets: ['198.51.100.0/24', 'git.corp.example'], setDns: false, command: [],
      secretConfigured: true, createdAt: new Date(now - 9 * day).toISOString(), updatedAt: new Date(now - 2 * day).toISOString(),
    },
    {
      id: 'p-5e6f7a8b', name: '运维网关（token 链接）', type: 'token-url', host: 'gw.ops.example', port: 10443, username: '',
      realm: '', trustedCert: 'e46d4aff08ba6914e64daa85bc6112a422fa7ce16631bff0b592a28556f993db', targets: ['203.0.113.0/24', '203.0.113.15'],
      setDns: false, command: [], secretConfigured: true, createdAt: new Date(now - 5 * day).toISOString(), updatedAt: new Date(now - 5 * day).toISOString(),
    },
    {
      id: 'p-9c0d1e2f', name: '测试环境（待配置）', type: 'password', host: 'vpn.lab.example', port: 8443, username: 'ci-bot',
      realm: 'lab', trustedCert: '', targets: ['198.18.0.0/20'], setDns: false, command: [],
      secretConfigured: false, createdAt: new Date(now - day).toISOString(), updatedAt: new Date(now - day).toISOString(),
    },
  ]
}

/** Log lines that match the scenario. */
function sampleLogs(now: number, state: VpnState): LogLine[] {
  const at = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString()
  const head: LogLine[] = [
    { t: at(4300), level: 'info', text: '连接 "公司内网 git"（password）' },
    { t: at(4299), level: 'out', text: 'INFO:   Connected to gateway.' },
    { t: at(4298), level: 'out', text: 'INFO:   Authenticated.' },
    { t: at(4298), level: 'out', text: 'INFO:   Remote gateway has allocated a VPN.' },
    { t: at(4297), level: 'out', text: 'INFO:   Interface ppp0 is UP.' },
    { t: at(4297), level: 'out', text: 'INFO:   Got addresses: [192.0.2.6], ns [192.0.2.1]' },
    { t: at(4297), level: 'out', text: 'INFO:   Tunnel is up and running.' },
  ]
  if (state === 'connecting') return head.slice(0, 3).map((line, index) => ({ ...line, t: at(6 - index * 2) }))
  if (state === 'failed') {
    return [
      { t: at(41), level: 'info', text: '连接 "公司内网 git"（password）' },
      { t: at(40), level: 'out', text: 'INFO:   Connected to gateway.' },
      { t: at(39), level: 'out', text: 'ERROR:  Could not authenticate to gateway. Please check the username and password.' },
      { t: at(39), level: 'error', text: '失败：authentication failed: check the account, password and realm' },
    ]
  }
  if (state === 'disconnected') return []
  return [
    ...head,
    { t: at(4296), level: 'info', text: 'route added: 198.51.100.0/24 -> ppp0' },
    { t: at(4296), level: 'info', text: 'route added: 198.51.100.40/32 -> ppp0' },
    { t: at(4295), level: 'info', text: '已连接；加了 2 条路由，默认路由未动' },
    { t: at(4265), level: 'info', text: '看门狗通过（30s）' },
    { t: at(300), level: 'out', text: 'DEBUG:  password = ***' },
  ]
}

/**
 * Create the sample source.
 * @param scenario - state the sample starts in.
 * @returns a source whose actions change in-memory state only.
 */
export function createMockSource(scenario: Scenario = 'connected'): VpnSource {
  const now0 = Date.now()
  let profiles = sampleProfiles(now0)
  let state: VpnState = scenario
  let activeId = profiles[0]?.id
  let connectedAt = now0 - 72 * MIN
  let error: string | undefined = scenario === 'failed' ? 'authentication failed: check the account, password and realm' : undefined
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined

  const notify = (): void => { for (const listener of listeners) listener() }

  const status = (): StatusView => {
    const profile = profiles.find(entry => entry.id === activeId)
    const up = state === 'connected'
    return {
      status: state,
      ...state === 'disconnected' || profile === undefined ? {} : { profileId: profile.id, profileName: profile.name },
      ...up ? { iface: 'ppp0', ip: '192.0.2.6', connectedAt: new Date(connectedAt).toISOString(), uptimeSeconds: Math.round((Date.now() - connectedAt) / 1000), pid: 31877 } : {},
      ...state === 'connecting' ? { iface: 'ppp0', pid: 31877 } : {},
      ...error === undefined ? {} : { error },
      routes: up ? ['198.51.100.0/24', '198.51.100.40/32'] : [],
      watchdog: up
        ? { state: 'passed' }
        : state === 'failed' ? { state: 'idle' } : { state: state === 'connecting' ? 'idle' : 'idle' },
      install: { installed: true, version: '1.20.0', cookieSupport: true, pppd: true, hint: '' },
      allowCustom: false,
      updatedAt: new Date().toISOString(),
    }
  }

  return {
    origin: 'mock',
    async read(): Promise<VpnSnapshot> {
      return { fetchedAt: new Date().toISOString(), status: status(), profiles, logs: sampleLogs(Date.now(), state), origin: 'mock' }
    },
    async save(input: ProfileInput): Promise<ProfileView> {
      const now = new Date().toISOString()
      const existing = profiles.find(entry => entry.id === input.id)
      const next: ProfileView = {
        id: existing?.id ?? `p-${Math.random().toString(16).slice(2, 10)}`,
        name: input.name, type: input.type, host: input.host ?? existing?.host ?? '', port: input.port ?? 443,
        username: input.username ?? '', realm: input.realm ?? '', trustedCert: input.trustedCert ?? '',
        targets: input.targets, setDns: input.setDns, command: input.command ?? [],
        secretConfigured: (input.secret ?? '') !== '' || existing?.secretConfigured === true,
        createdAt: existing?.createdAt ?? now, updatedAt: now,
      }
      profiles = existing === undefined ? [...profiles, next] : profiles.map(entry => (entry.id === next.id ? next : entry))
      notify()
      return next
    },
    async remove(id: string): Promise<void> {
      profiles = profiles.filter(entry => entry.id !== id)
      notify()
    },
    async connect(id: string): Promise<void> {
      activeId = id
      state = 'connecting'
      error = undefined
      notify()
      timer = setTimeout(() => { state = 'connected'; connectedAt = Date.now(); notify() }, 2500)
    },
    async disconnect(): Promise<void> {
      if (timer !== undefined) clearTimeout(timer)
      state = 'disconnected'
      error = undefined
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
