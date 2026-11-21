# dsh-secrets — design

A local encrypted secret vault for DeepSeek Harness. Agents can **write and use**
secrets, but never **read** them back. There is no `secret_get` and no code path
that returns a value.

## 1. Reuse decision

DSH already has `ctx.credentials`, backed by `dsh-credentials-local`
(`<DSH home>/.credentials.yaml`). It stores plaintext YAML protected only by mode
0600. A profile can mount only one CredentialProvider, and that provider has no
enumeration, rename or encryption.

**Decision:** build a standalone vault. Do not replace the credentials provider.
Replacing it would change profile composition and how LLM keys resolve, which
needs the user's explicit consent.

Patterns reused from the existing code:

| Pattern | Source | Here |
|---|---|---|
| Refuse a group/other-readable file (`mode & 0o077`), tell the user to chmod | credentials-local `GROUP_OTHER_BITS` | `vault.js` `assertPrivate()` |
| File 0600, parent dir 0700 on create | credentials-local `writeFileAtomic(..., {mode:0o600, dirMode:0o700})` | `vault.js` |
| Atomic write: tmp sibling, fsync, rename | dsh-router-b `board.ts` | `vault.js` `atomicWrite()` |
| Longest-first `replaceAll` redaction | dsh-mcp-client `diagnostic.ts` | `redact.js` |

**Future option:** dsh-secrets could also implement the CredentialProvider
interface, so LLM keys are stored encrypted too. That would replace the mounted
`dsh-credentials-local` row and needs user consent. It is out of scope for now.

## 2. Threat model

**Protected against**

- The vault file being copied off the machine, backed up, or read by another
  UID. The file is AES-256-GCM encrypted, mode 0600, in a 0700 directory, and
  the plugin refuses to open it when group/other bits are set.
- Casual exposure to the model. No tool returns a value. `secret_exec` and
  `secret_http` redact injected values from what they return. An optional global
  `tools/post-execute` listener redacts known values (length ≥ `redactMinLength`)
  from the text output of **every** tool.
- Tampering. GCM authenticates the ciphertext and the header (the header is the
  AAD), so any modified byte makes decryption fail.

**Honest limits (not protected)**

- **Same-UID processes.** Anything running as the DSH user can read the keyfile
  or the passphrase environment variable, and can then decrypt the vault. The
  encryption protects data at rest, not against a compromised account.
- **`secret_exec` can be abused.** The child process holds the plaintext in its
  environment. A command like `printenv | base64 -w0 | rev`, or one that writes
  the value to a file or sends it over the network, defeats redaction. Redaction
  covers the literal value plus its base64, base64url, URL-encoded and hex forms
  as they appear in stdout/stderr. That is best effort for common encodings, not
  a guarantee. Mitigation: set `execAllowedCommands` to a fixed list of
  executables (for example `["curl", "git"]`). Even then, an allowed command
  with arbitrary arguments (`bash -c ...`) is as powerful as a shell.
- **`secret_http` sends secrets where the agent says.** An agent can point it at
  a host it controls. Mitigation: `httpAllowedHosts`. The default allows every
  host, which is a deliberate convenience trade-off.
- **`secret_set` arguments are logged.** DSH records tool arguments in the
  session log and shows them in the UI before any plugin runs. The value passed
  to `secret_set` is therefore visible in the transcript of that one call. The
  vault cannot fix that. To keep a value out of transcripts, set it from a
  session whose log you then delete, or use a future out-of-band CLI.
- **Fingerprints.** `fingerprint` is the first 8 hex characters of
  `sha256(value)`. For a low-entropy secret (a short PIN) it allows offline
  guessing. API keys and tokens are not at risk from it.
- **Short secrets.** Values shorter than 4 characters get only literal
  redaction; the global listener skips values shorter than `redactMinLength`
  (default 8) so that it cannot mangle unrelated output.
- **Memory.** Plaintext lives in process memory for the duration of one
  operation. JavaScript strings cannot be zeroed, so it stays in the heap until
  garbage collection.

**Passphrase lost = data lost.** There is no recovery, no backdoor and no key
escrow. Losing the passphrase or the keyfile makes the vault and every export
made from it permanently unreadable.

## 3. File format

Vault (`<DSH home>/secrets.vault`, configurable via `vaultPath`), UTF-8 JSON:

```json
{
  "format": "dsh-secrets-vault",
  "version": 1,
  "kdf": { "name": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "<b64 16 bytes>", "keyLen": 32 },
  "cipher": "aes-256-gcm",
  "nonce": "<b64 12 bytes, fresh per write>",
  "tag": "<b64 16 bytes>",
  "ciphertext": "<b64>"
}
```

With `keySource: "keyfile"` the kdf is
`{ "name": "keyfile", "hkdf": "sha256", "salt": "<b64>", "keyLen": 32 }`.

**AAD** is the UTF-8 JSON of `[format, version, kdf, cipher, nonce]` with the kdf
keys in a fixed order. Changing any header field, including the KDF parameters,
fails authentication.

**Plaintext payload** (only ever in memory):

```json
{ "entries": { "NAME": { "value": "...", "description": "...", "tags": ["..."],
  "createdAt": "ISO", "updatedAt": "ISO", "metaUpdatedAt": "ISO" } } }
```

`fingerprint` and `length` are computed from the value on demand and not stored.

The salt is created with the vault and kept across writes, so the derived key
stays the same. The nonce is new (random 12 bytes) for each write.

## 4. Key derivation

- `keySource: "passphrase-env"` (default): passphrase from the environment
  variable named by `passphraseEnv` (default `DSH_SECRETS_PASSPHRASE`), then
  scrypt with N=32768 (2^15), r=8, p=1, 16-byte salt, 32-byte key, maxmem 64 MiB.
  N/r/p are configurable (`scryptN`, `scryptR`, `scryptP`; N must be a power of
  two ≥ 1024) and are written into the header, so an existing vault always opens
  with its own parameters.
- `keySource: "keyfile"`: `keyfilePath` (default `<DSH home>/secrets.key`) must be
  a regular file with mode 0600 (no group/other bits). Its content is decoded as
  64 hex characters, as base64 of 32 bytes, or otherwise used as raw bytes
  (at least 32). The key is `HKDF-SHA256(content, salt, "dsh-secrets-vault-v1", 32)`.
- A missing key gives `master key missing: set environment variable <NAME>`
  or `master key missing: keyfile not found at <path>`. A wrong key gives
  `decryption failed: wrong passphrase or corrupted file`.
- A vault whose kdf name differs from the configured `keySource` is refused.

**Caching.** Derived keys are cached in process memory, keyed by
`sha256(kdf params + salt + key material)`, because scrypt costs ~100 ms.
Decrypted entries are **never cached**: each operation reads, decrypts, uses
and drops them. Export passphrases are never cached.

## 5. Names

`/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/`. `.` and `-` are allowed for readability
(`github.token`). When `secret_exec` receives a plain list of names, each name
must also be a valid env var name (`/^[A-Za-z_][A-Za-z0-9_]*$/`); otherwise use the
mapping form `{ "GITHUB_TOKEN": "github.token" }`.

## 6. Tools API

No result ever contains a value. Errors are thrown as `Error(message)` and the
message never contains a value or passphrase.

Common entry summary `Item`:
`{ name, description, tags, fingerprint, length, createdAt, updatedAt, metaUpdatedAt }`.

| Tool | Parameters | Returns |
|---|---|---|
| `secret_set` | `name`, `value` (non-empty string, stored literally), `description?`, `tags?: string[]` | `{ name, fingerprint, length, created, hint? }`. `hint: "建议补充描述 (description)"` when a new entry has no description. Overwrite keeps `createdAt` and existing description/tags unless given. |
| `secret_describe` | `name`, `description?`, `tags?` (at least one) | `{ name, fingerprint, length, description, tags, updatedAt, metaUpdatedAt }`. Changes only metadata: `metaUpdatedAt` moves, `updatedAt` (value changes only) and the value stay. |
| `secret_list` | `tag?`, `query?` | `{ items: Item[], total }`. `description` truncated to 60 characters (Unicode code points) plus `…`. `tag` is an exact match; `query` is a case-insensitive substring of name or full description. Sorted by name. |
| `secret_delete` | `name` | `{ name, deleted: true }` |
| `secret_rename` | `from`, `to`, `overwrite?` (default false) | `{ from, to, overwritten }`. Error if `to` exists and `overwrite` is not true. Timestamps are kept. |
| `secret_check` | `name`, `value?` | `{ name, exists, fingerprint? , matches? }`. `matches` uses `crypto.timingSafeEqual` on SHA-256 digests. |
| `secret_exec` | `command` (executable, no shell), `args?: string[]`, `secrets: string[] \| {ENV: name}`, `env?: {K: string}`, `cwd?`, `timeoutMs?` | `{ command, args, exitCode, signal, success, timedOut, aborted, stdout, stderr, truncated: {stdout, stderr}, injected: [{env, name, fingerprint}] }` |
| `secret_http` | `url`, `method?` (default GET), `headers?: {K: string}`, `body?: string`, `timeoutMs?` | `{ status, ok, url, headers, body, truncated, redirected }` |
| `secret_export` | `path` (directory or new file), `passphrase` (≥ 8 chars) | `{ path, sha256, entries, bytes }` |
| `secret_import` | `path`, `passphrase`, `strategy: "merge" \| "replace"`, `onConflict?: "overwrite" \| "skip"` (merge only, default `skip`) | `{ strategy, added, overwritten, skipped, removed }` |

### secret_exec

- `command` + `args` are passed to `child_process.spawn` with `shell: false`.
  There is no shell string form; to use a shell, call
  `{ command: "bash", args: ["-c", "..."] }` explicitly, so the choice is visible.
- The child environment is `process.env` + `env` + injected secrets. An `env` key
  that collides with an injected name is an error.
- `execAllowedCommands` (default `null` = any) restricts `command` by exact
  string or basename.
- `timeoutMs` default `execTimeoutMs` (60 000), capped by `execMaxTimeoutMs`
  (600 000). Timeout or `exec.signal` abort sends SIGTERM, then SIGKILL after 2 s.
- stdout/stderr are collected up to 1 MiB each, redacted, then truncated to
  `maxOutputChars` (65 536). When collection hit the 1 MiB cap, the last
  `longest redaction form` characters are dropped before redaction, so a value
  cut at the boundary cannot leak as an unredacted prefix.
- `command` and `args` echoes are redacted too. Unknown secret → `secret not
  found: NAME`. Spawn failure → `failed to start command: ENOENT` (code only).

### secret_http

- Placeholders `${secret:NAME}` are substituted in `url`, header values and
  `body`. `$${secret:` is an escape that produces a literal `${secret:`.
- Errors: unknown name → `secret not found: NAME`; empty name, invalid name or
  missing `}` → `malformed placeholder at offset N in <field>` (offset of the
  `$` in that field; field is `url`, `body` or `header <Key>`).
- `httpAllowedHosts` (default `null` = all hosts; exact host or `*.suffix`)
  is checked on the substituted URL. Only `http:`/`https:` are allowed.
- Redirects are not followed by default (`httpFollowRedirects: false`), so a
  secret header is never forwarded to a redirect target; the 3xx status and
  redacted `location` header are returned.
- Response headers and body are redacted, then the body is truncated to
  `maxOutputChars`. Network error messages are redacted.

### secret_export / secret_import

- Export writes one file with the same envelope, `format: "dsh-secrets-export"`,
  scrypt (vault's N/r/p) from the given passphrase with a fresh salt, so it is
  independent of the vault key. Descriptions, tags and timestamps are inside the
  encrypted payload; nothing but the header is plaintext.
- If `path` is an existing directory the file is
  `secrets-export-YYYYMMDDTHHMMSSZ.dshvault` inside it; otherwise `path` is the
  file. An existing file is never overwritten (`wx` open). Mode 0600, fsync.
- Import: a GCM failure gives `decryption failed: wrong passphrase or corrupted
  file`. `merge` adds new names and, on conflict, overwrites or skips.
  `replace` makes the vault exactly the imported set; `removed` counts dropped
  names. Imported entries keep their timestamps.

## 7. Redaction design (`redact.js`)

For each secret value, the forms are: literal; and when the value has ≥ 4
characters, also standard base64, base64 without padding, base64url, URL
encoding (`encodeURIComponent`) and lowercase/uppercase hex of the UTF-8 bytes.
Every form maps to `[REDACTED:NAME]`. Forms are deduplicated and replaced
longest first with `replaceAll`, so a secret that contains another secret is
replaced as the longer one. Base64 of a larger string that contains the secret
at an unaligned offset is not detected (documented limit).

**Global listener.** If `redactToolOutput` is true (default) and `ctx.on` exists,
the plugin registers a `tools/post-execute` waterfall listener. After `next()`,
for an `accept` decision that does not replace `value`, it decrypts the vault
(only if the vault file exists and the key is available), builds a redactor from
values with length ≥ `redactMinLength` (default 8), and replaces text blocks.
It returns `{ kind: "accept", content, additionalContexts }` only when something
changed. Any failure inside the listener is swallowed (logged without detail)
and the original decision is returned. Absence of the event never fails `apply`.
Limit: this covers the model-facing content blocks only, not the canonical
`value` of other tools nor tool arguments.

## 8. Concurrency

- Within a process: all mutations of one vault path go through a promise-chain
  mutex.
- Across processes: an `O_CREAT|O_EXCL` lock file `<vault>.lock` holding
  `{pid, at}`. Waiters retry with backoff up to `lockTimeoutMs` (10 000). A lock
  older than `lockStaleMs` (30 000) or whose pid is dead is removed.
- Writes: `<vault>.tmp-<pid>-<random>` opened `wx` with mode 0600, written,
  fsynced, renamed over the vault, then the directory is fsynced. The tmp file is
  removed on failure. Readers never see a torn file.
- Reads (`secret_list`, `secret_check`, use in exec/http) take no lock; rename
  makes the file they read always complete.

## 9. Config keys

| Key | Default | Meaning |
|---|---|---|
| `vaultPath` | `<DSH_HOME or ~/.dsh>/secrets.vault` | vault file |
| `keySource` | `passphrase-env` | or `keyfile` |
| `passphraseEnv` | `DSH_SECRETS_PASSPHRASE` | env var holding the passphrase |
| `keyfilePath` | `<DSH home>/secrets.key` | used when `keySource: keyfile` |
| `scryptN` / `scryptR` / `scryptP` | 32768 / 8 / 1 | for new vaults and exports |
| `maxOutputChars` | 65536 | truncation of exec/http output |
| `execTimeoutMs` / `execMaxTimeoutMs` | 60000 / 600000 | |
| `execAllowedCommands` | `null` (any) | list of allowed commands |
| `httpAllowedHosts` | `null` (any) | list of hosts or `*.suffix` |
| `httpTimeoutMs` | 30000 | |
| `httpFollowRedirects` | false | |
| `redactToolOutput` | true | global post-execute redaction |
| `redactMinLength` | 8 | minimum value length for global redaction |
| `lockTimeoutMs` / `lockStaleMs` | 10000 / 30000 | |

Config is validated by hand in `apply`; an invalid key throws with the key name.

## 10. Layout

```
dsh-secrets/
  package.json            bundle manifest, dsh.bundle.patch
  index.js                no-op bundle entry
  cordis.patch.yml        inserts dsh-host-secrets
  scripts/install.mjs     profile installer (link: dep, bundles entry, symlink)
  packages/host-secrets/
    index.js              apply(): config, tools, post-execute listener
    config.js vault.js redact.js placeholders.js tools.js
    tests/*.test.mjs      node --test
```
