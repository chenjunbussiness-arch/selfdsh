/**
 * Page copy, zh and en. `{name}` is the shell's interpolation syntax.
 */

export const NS = 'fileshare'

export const zh = {
  'page.nav': '文件中转',
  'page.title': '文件中转',
  'page.subtitle': '给文件生成临时下载、上传链接，不用再 scp。链接就是凭证，过期或撤销后立刻失效。',
  'page.refresh': '刷新',

  'base.label': '链接地址',
  'base.config': '来自配置',
  'base.browser': '来自你访问 DSH 的地址',
  'base.none': '还不知道对外地址，链接只能给出路径。在 dsh-fileshare 配置里设 publicBaseUrl，或从对外域名打开一次 DSH。',

  'share.title': '分享文件',
  'share.sub': '生成下载链接，浏览器或 curl 都能直接下。',
  'share.path': '文件路径',
  'share.path.hint': '绝对路径，要在允许的文件夹里',
  'share.ttl': '有效期',
  'share.limit': '次数',
  'share.limit.none': '不限',
  'share.limit.one': '1 次',
  'share.limit.five': '5 次',
  'share.submit': '生成下载链接',

  'receive.title': '收文件',
  'receive.sub': '生成上传链接，对方拖进网页或 curl -T 就能传上来。',
  'receive.dir': '放到',
  'receive.dir.hint': '留空就放进收件箱 {inbox}',
  'receive.size': '容量',
  'receive.submit': '生成上传链接',

  'ttl.15': '15 分钟',
  'ttl.30': '30 分钟',
  'ttl.60': '1 小时',
  'ttl.120': '2 小时',
  'ttl.1440': '1 天',
  'ttl.10080': '7 天',

  'created.title': '链接已生成',
  'created.once': '完整链接只显示这一次，关掉页面后列表里不会再显示。',
  'created.copy': '复制',
  'created.copied': '已复制',
  'created.open': '打开',
  'created.pathOnly': '还不知道对外地址，只能给出路径：',

  'roots.title': '允许的文件夹',
  'roots.none': '还没有允许的文件夹。在配置 roots 里加，或让 agent 在它的工作目录里分享一次。',

  'list.title': '链接',
  'list.active': '有效',
  'list.all': '全部',
  'list.empty': '还没有链接。',
  'list.revoke': '撤销',
  'list.copy': '复制链接',
  'list.kind.download': '下载',
  'list.kind.upload': '上传',
  'list.state.active': '有效',
  'list.state.expired': '已过期',
  'list.state.revoked': '已撤销',
  'list.state.used-up': '已用完',
  'list.expires': '{time} 到期',
  'list.ended': '{time} 结束',
  'list.downloads': '下载 {count} 次',
  'list.downloadsOf': '下载 {count}/{max} 次',
  'list.received': '收到 {count}/{max} 个 · {size}',
  'list.by.agent': 'agent 生成',
  'list.by.page': '页面生成',

  'error.load': '读取失败：{message}',
  'error.action': '操作失败：{message}',
}

export const en: Record<keyof typeof zh, string> = {
  'page.nav': 'File drop',
  'page.title': 'File drop',
  'page.subtitle': 'Temporary download and upload links, instead of scp. The link is the credential; it stops working when it expires or is revoked.',
  'page.refresh': 'Refresh',

  'base.label': 'Link address',
  'base.config': 'from config',
  'base.browser': 'from the address you use for DSH',
  'base.none': 'No public address yet, so links are paths only. Set publicBaseUrl in the dsh-fileshare config, or open DSH once through its public address.',

  'share.title': 'Share a file',
  'share.sub': 'A download link for a browser or curl.',
  'share.path': 'File path',
  'share.path.hint': 'Absolute path inside an allowed folder',
  'share.ttl': 'Lifetime',
  'share.limit': 'Downloads',
  'share.limit.none': 'Unlimited',
  'share.limit.one': 'Once',
  'share.limit.five': '5 times',
  'share.submit': 'Create download link',

  'receive.title': 'Receive files',
  'receive.sub': 'An upload link: drop files on the page, or curl -T.',
  'receive.dir': 'Into',
  'receive.dir.hint': 'Empty: the inbox {inbox}',
  'receive.size': 'Capacity',
  'receive.submit': 'Create upload link',

  'ttl.15': '15 min',
  'ttl.30': '30 min',
  'ttl.60': '1 hour',
  'ttl.120': '2 hours',
  'ttl.1440': '1 day',
  'ttl.10080': '7 days',

  'created.title': 'Link created',
  'created.once': 'The full link is shown only now; the list will not show it again.',
  'created.copy': 'Copy',
  'created.copied': 'Copied',
  'created.open': 'Open',
  'created.pathOnly': 'No public address yet, so only the path:',

  'roots.title': 'Allowed folders',
  'roots.none': 'No allowed folders yet. Add roots in the config, or let an agent share once from its working directory.',

  'list.title': 'Links',
  'list.active': 'Active',
  'list.all': 'All',
  'list.empty': 'No links yet.',
  'list.revoke': 'Revoke',
  'list.copy': 'Copy link',
  'list.kind.download': 'Download',
  'list.kind.upload': 'Upload',
  'list.state.active': 'Active',
  'list.state.expired': 'Expired',
  'list.state.revoked': 'Revoked',
  'list.state.used-up': 'Used up',
  'list.expires': 'expires {time}',
  'list.ended': 'ended {time}',
  'list.downloads': '{count} downloads',
  'list.downloadsOf': '{count}/{max} downloads',
  'list.received': '{count}/{max} files · {size}',
  'list.by.agent': 'by an agent',
  'list.by.page': 'from this page',

  'error.load': 'Could not load: {message}',
  'error.action': 'Failed: {message}',
}

export const DICTIONARIES: Record<string, Record<string, string>> = { zh: { ...zh }, en: { ...en } }
export type MessageKey = keyof typeof zh
export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string
