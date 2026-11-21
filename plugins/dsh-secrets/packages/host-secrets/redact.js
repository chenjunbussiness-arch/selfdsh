/**
 * Best-effort redaction of known secret values and their common encodings.
 *
 * Forms per value: the literal, and for values of 4+ characters also base64
 * (padded and unpadded), base64url, URL encoding, and lower/upper hex of the
 * UTF-8 bytes. All forms of all values are replaced longest first with
 * `replaceAll`, so a secret containing another secret is replaced as the
 * longer one.
 *
 * @module dsh-host-secrets/redact
 */

/** Encoded forms of one value (deduplicated, literal first). */
export function formsOf(value) {
  const forms = new Set([value])
  if ([...value].length >= 4) {
    const bytes = Buffer.from(value, 'utf8')
    const b64 = bytes.toString('base64')
    forms.add(b64)
    forms.add(b64.replace(/=+$/, ''))
    forms.add(bytes.toString('base64url'))
    forms.add(encodeURIComponent(value))
    const hex = bytes.toString('hex')
    forms.add(hex)
    forms.add(hex.toUpperCase())
  }
  forms.delete('')
  return [...forms]
}

/**
 * Build a redactor for `{ name: value }` pairs.
 * @param {Iterable<[string, string]>} pairs
 * @returns {{ redact(text: string): string, maxForm: number, empty: boolean }}
 */
export function createRedactor(pairs) {
  /** form -> name; when two secrets share a form, the first name wins. */
  const table = new Map()
  for (const [name, value] of pairs) {
    if (typeof value !== 'string' || value === '') continue
    for (const form of formsOf(value)) if (!table.has(form)) table.set(form, name)
  }
  const ordered = [...table.entries()].sort((a, b) => b[0].length - a[0].length)
  const maxForm = ordered.length > 0 ? ordered[0][0].length : 0
  return {
    empty: ordered.length === 0,
    maxForm,
    redact(text) {
      if (typeof text !== 'string' || ordered.length === 0) return text
      let out = text
      for (const [form, name] of ordered) {
        if (out.includes(form)) out = out.replaceAll(form, `[REDACTED:${name}]`)
      }
      return out
    },
  }
}

/** Redact every string inside a JSON-like value (keys and values). */
export function redactDeep(value, redactor) {
  if (typeof value === 'string') return redactor.redact(value)
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redactor))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[redactor.redact(key)] = redactDeep(item, redactor)
    return out
  }
  return value
}

/** Truncate to `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false }
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return { text: `${text.slice(0, end)}\n…[truncated ${text.length - end} chars]`, truncated: true }
}
