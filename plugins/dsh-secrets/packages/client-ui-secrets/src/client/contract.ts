/**
 * Shapes of the two read-only routes served by dsh-host-secrets
 * (packages/host-secrets/bridge.js). Neither ever carries a secret value.
 */

/** Why the vault is (not) readable. */
export type VaultState = 'missing' | 'unlocked' | 'locked' | 'error'

/** Vault status, embedded in both documents. */
export interface VaultStatus {
  /** `missing`: no vault file yet; `unlocked`: decrypted fine; `locked`: no/wrong master key; `error`: unreadable. */
  state: VaultState
  exists: boolean
  unlocked: boolean
  keySource: 'passphrase-env' | 'keyfile'
  /** Whether master key material is available right now (env var set / keyfile readable). */
  keyConfigured: boolean
  /** Absolute vault path on the host. */
  path: string
  /** Present when `state` is `locked` or `error`. */
  error?: { code: string; message: string }
}

/** One value-free entry: exactly what `secret_list` returns, with the full description. */
export interface SecretItem {
  name: string
  description: string
  tags: string[]
  /** First 8 hex chars of sha256(value). */
  fingerprint: string
  /** Value length in Unicode code points. */
  length: number
  createdAt: string
  /** Last time the value changed. */
  updatedAt: string
  /** Last time description/tags changed. */
  metaUpdatedAt: string
}

/** `GET /api/secrets/list[?tag=&query=]`. */
export interface ListDocument {
  generatedAt: string
  vault: VaultStatus
  filter: { tag: string | null; query: string | null }
  /** Entries in the vault, unfiltered. */
  total: number
  /** Entries matching the filter (= items.length). */
  matched: number
  items: SecretItem[]
}

/** `GET /api/secrets/summary`. */
export interface SummaryDocument {
  generatedAt: string
  vault: VaultStatus
  total: number
  untagged: number
  /** Count desc, then tag asc. */
  tags: { tag: string; count: number }[]
  lastUpdatedAt: string | null
  lastMetaUpdatedAt: string | null
}

/** The filter the page asks for. */
export interface Filter {
  tag?: string
  query?: string
}

// --- management routes (packages/host-secrets/manage.js) -----------------------

/** One managed reference in DSH's credential store: presence only, never a value. */
export interface CredentialItem {
  ref: string
  configured: boolean
  /** `file` (credential store), `env`, `user-env`, `project-env`, `unknown` or null. */
  source: string | null
  writable: boolean
}

/** `GET /api/secrets/credentials`. */
export interface CredentialsDocument {
  generatedAt: string
  /** Whether this DSH mounts a credential store at all. */
  available: boolean
  items: CredentialItem[]
}

/** One agent-hub controller.env key. `value` only for non-secret keys. */
export interface HubItem {
  key: string
  secret: boolean
  required: boolean
  configured: boolean
  source: 'env' | 'file' | null
  /** Set in both the process environment and the file: the environment wins. */
  shadowed: boolean
  value?: string | null
}

/** agent-hub connection file status. */
export interface HubStatus {
  file: string
  exists: boolean
  error?: string
  items: HubItem[]
}

/** What one plugin needs. */
export interface PluginNeed {
  key: string
  kind: 'credential' | 'hub' | 'vault-key'
  required: boolean
  configured: boolean
  source: string | null
}

/** One selfdsh plugin. */
export interface PluginInfo {
  id: string
  installed: boolean
  profiles: string[]
  needs: PluginNeed[]
}

/** `GET /api/secrets/plugins`. */
export interface PluginsDocument {
  generatedAt: string
  profiles: { name: string; running: boolean }[]
  credentialStore: boolean
  hub: HubStatus
  plugins: PluginInfo[]
}

/** Result of a vault write: value-free. */
export interface VaultWriteResult {
  name?: string
  fingerprint?: string
  length?: number
  created?: boolean
}
