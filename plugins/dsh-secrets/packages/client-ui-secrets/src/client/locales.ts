/**
 * Page copy, zh and en. Registered through `ctx.locale.register`; `{name}` is
 * the shell's interpolation syntax.
 */

/** Locale namespace id. */
export const NS = 'secretsDashboard'

export const zh = {
  'page.title': '密钥看板',
  'page.nav': '密钥',
  'page.subtitle': '本机 dsh-secrets 保险库的只读视图：名称、描述、标签、指纹、长度与更新时间。',
  'notice.title': '值不可查看',
  'notice.body': '本页只显示元数据，任何接口都不返回密钥明文。密钥只能通过 secret_* 工具使用：secret_exec 注入环境变量、secret_http 在请求里用 {placeholder} 占位符；核对用 secret_check。',
  'notice.fingerprint': '指纹 = SHA-256(值) 的前 8 位十六进制；长度 = 字符数。二者用于核对是否同一个值，不能还原明文。',

  'vault.state.unlocked': '已解锁',
  'vault.state.missing': '尚未创建',
  'vault.state.locked': '已锁定',
  'vault.state.error': '无法读取',
  'vault.keySource.passphrase-env': '主密钥：环境变量口令',
  'vault.keySource.keyfile': '主密钥：keyfile',
  'vault.key.configured': '主密钥已就绪',
  'vault.key.missing': '主密钥未配置',
  'vault.path': '保险库文件：{path}',
  'vault.count': '共 {total} 个密钥',
  'vault.lastUpdated': '最近更新 {time}',

  'locked.title': '保险库已锁定，无法列出密钥',
  'locked.key-missing': '服务进程里没有主密钥。设置环境变量（默认 DSH_SECRETS_PASSPHRASE）或配置 keyfile 后重启服务。',
  'locked.decrypt-failed': '主密钥不对，或保险库文件已损坏。确认服务进程里的口令 / keyfile 与写入时一致。',
  'locked.key-invalid': 'keyfile 无法使用（权限或长度不符）。按提示修正后刷新。',
  'locked.key-source-mismatch': '保险库的加密方式与当前 keySource 配置不一致。',
  'locked.generic': '无法解密保险库。',
  'error.vault.title': '保险库文件无法读取',
  'detail': '详情：{message}',

  'filter.search': '搜索名称或描述…',
  'filter.search.aria': '按名称或描述搜索',
  'filter.tags.aria': '按标签筛选',
  'filter.all': '全部',
  'filter.untagged': '{count} 个无标签',
  'filter.clear': '清除筛选',
  'filter.matched': '显示 {matched} / {total}',

  'refresh': '刷新',
  'refreshing': '刷新中…',
  'updatedAt': '更新于 {time}',
  'stale': '刷新失败（{message}），下面是 {time} 的数据',

  'col.name': '名称',
  'col.description': '描述',
  'col.tags': '标签',
  'col.fingerprint': '指纹',
  'col.length': '长度',
  'col.updated': '更新时间',
  'cell.noDescription': '（无描述）',
  'cell.noTags': '—',
  'cell.length': '{count} 字符',
  'cell.tagFilter': '只看标签 {tag}',
  'cell.times': '创建 {created}\n值更新 {updated}\n元数据更新 {meta}',

  'age.now': '刚刚',
  'age.minutes': '{count} 分钟前',
  'age.hours': '{count} 小时前',
  'age.days': '{count} 天前',
  'age.months': '{count} 个月前',
  'age.years': '{count} 年前',

  'loading': '正在读取保险库…',
  'empty.missing.title': '保险库还没有创建',
  'empty.missing.hint': '第一次调用 secret_set 存入密钥时会自动创建。也可以用 ingest-file.mjs 批量导入。',
  'empty.vault.title': '保险库是空的',
  'empty.vault.hint': '用 secret_set 存入第一个密钥（建议同时写 description 和 tags）。',
  'empty.filter.title': '没有匹配的密钥',
  'empty.filter.hint': '换个关键字或标签试试。注意：搜索只匹配名称和描述，不匹配值。',

  'error.title': '读不到密钥看板数据',
  'error.hint': '宿主侧的只读接口 /api/secrets/* 没有正常响应。页面其余部分不受影响。',
  'error.unauthorized': '登录已失效，请重新登录后再试。',
  'error.unavailable': '登录服务暂不可用，或 dsh-host-secrets 没有挂载看板接口。',
  'retry': '重试',
} as const

/** English mirror of {@link zh}. */
export const en: Record<keyof typeof zh, string> = {
  'page.title': 'Secrets dashboard',
  'page.nav': 'Secrets',
  'page.subtitle': 'Read-only view of the local dsh-secrets vault: name, description, tags, fingerprint, length and update time.',
  'notice.title': 'Values cannot be viewed',
  'notice.body': 'This page shows metadata only; no route ever returns a secret value. Secrets can only be used through the secret_* tools: secret_exec injects them as environment variables, secret_http fills {placeholder} placeholders in a request, secret_check compares a candidate.',
  'notice.fingerprint': 'Fingerprint = first 8 hex chars of SHA-256(value); length = characters. Both tell values apart; neither reveals one.',

  'vault.state.unlocked': 'Unlocked',
  'vault.state.missing': 'Not created yet',
  'vault.state.locked': 'Locked',
  'vault.state.error': 'Unreadable',
  'vault.keySource.passphrase-env': 'Master key: passphrase env var',
  'vault.keySource.keyfile': 'Master key: keyfile',
  'vault.key.configured': 'master key available',
  'vault.key.missing': 'master key not configured',
  'vault.path': 'Vault file: {path}',
  'vault.count': '{total} secrets',
  'vault.lastUpdated': 'last updated {time}',

  'locked.title': 'The vault is locked; secrets cannot be listed',
  'locked.key-missing': 'The service has no master key. Set the environment variable (default DSH_SECRETS_PASSPHRASE) or configure a keyfile, then restart the service.',
  'locked.decrypt-failed': 'Wrong master key, or the vault file is corrupted. Make sure the service uses the passphrase / keyfile the vault was written with.',
  'locked.key-invalid': 'The keyfile cannot be used (permissions or length). Fix it as described and refresh.',
  'locked.key-source-mismatch': 'The vault was encrypted with a different keySource than the one configured.',
  'locked.generic': 'The vault cannot be decrypted.',
  'error.vault.title': 'The vault file cannot be read',
  'detail': 'Details: {message}',

  'filter.search': 'Search name or description…',
  'filter.search.aria': 'Search by name or description',
  'filter.tags.aria': 'Filter by tag',
  'filter.all': 'All',
  'filter.untagged': '{count} untagged',
  'filter.clear': 'Clear filters',
  'filter.matched': 'Showing {matched} / {total}',

  'refresh': 'Refresh',
  'refreshing': 'Refreshing…',
  'updatedAt': 'Updated {time}',
  'stale': 'Refresh failed ({message}); showing data from {time}',

  'col.name': 'Name',
  'col.description': 'Description',
  'col.tags': 'Tags',
  'col.fingerprint': 'Fingerprint',
  'col.length': 'Length',
  'col.updated': 'Updated',
  'cell.noDescription': '(no description)',
  'cell.noTags': '—',
  'cell.length': '{count} chars',
  'cell.tagFilter': 'Only tag {tag}',
  'cell.times': 'Created {created}\nValue updated {updated}\nMetadata updated {meta}',

  'age.now': 'just now',
  'age.minutes': '{count} min ago',
  'age.hours': '{count} h ago',
  'age.days': '{count} d ago',
  'age.months': '{count} mo ago',
  'age.years': '{count} y ago',

  'loading': 'Reading the vault…',
  'empty.missing.title': 'No vault yet',
  'empty.missing.hint': 'It is created by the first secret_set call. ingest-file.mjs can bulk-import as well.',
  'empty.vault.title': 'The vault is empty',
  'empty.vault.hint': 'Store the first secret with secret_set (a description and tags help later).',
  'empty.filter.title': 'No matching secrets',
  'empty.filter.hint': 'Try another keyword or tag. Search matches names and descriptions, never values.',

  'error.title': 'Secrets dashboard data is unreachable',
  'error.hint': 'The host-side read-only routes /api/secrets/* did not answer. The rest of the page is unaffected.',
  'error.unauthorized': 'Your login has expired. Sign in again and retry.',
  'error.unavailable': 'The login service is unavailable, or dsh-host-secrets did not mount the dashboard routes.',
  'retry': 'Retry',
}

/** Dictionaries passed to the locale service. */
export const DICTIONARIES: Record<string, Record<string, string>> = { zh: { ...zh }, en: { ...en } }

/** Every key the page uses. */
export type MessageKey = keyof typeof zh

/** One translate function bound to {@link NS}. */
export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string
