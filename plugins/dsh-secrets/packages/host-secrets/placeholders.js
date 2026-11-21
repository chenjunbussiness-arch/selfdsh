/**
 * `${secret:NAME}` placeholder parsing and substitution.
 *
 * Grammar: `${secret:` NAME `}` where NAME matches the vault name pattern.
 * `$${secret:` is an escape producing a literal `${secret:`. Any other `$` is
 * literal. Offsets in errors are 0-based UTF-16 offsets of the `$` in the field.
 *
 * @module dsh-host-secrets/placeholders
 */

import { NAME_RE } from './vault.js'

const OPEN = '${secret:'

/**
 * Parse a template into literal and reference parts.
 * @param {string} text
 * @param {string} field - label used in errors (`url`, `body`, `header X`).
 * @returns {Array<{literal: string} | {ref: string}>}
 */
export function parseTemplate(text, field) {
  const parts = []
  let literal = ''
  let i = 0
  while (i < text.length) {
    if (text.startsWith('$' + OPEN, i)) {
      literal += OPEN
      i += 1 + OPEN.length
      continue
    }
    if (text.startsWith(OPEN, i)) {
      const close = text.indexOf('}', i + OPEN.length)
      if (close < 0) throw new Error(`malformed placeholder at offset ${i} in ${field}`)
      const name = text.slice(i + OPEN.length, close)
      if (!NAME_RE.test(name)) throw new Error(`malformed placeholder at offset ${i} in ${field}`)
      if (literal !== '') parts.push({ literal })
      literal = ''
      parts.push({ ref: name })
      i = close + 1
      continue
    }
    literal += text[i]
    i += 1
  }
  if (literal !== '') parts.push({ literal })
  return parts
}

/** Names referenced by parsed parts. */
export function refsOf(parts) {
  return parts.filter(part => 'ref' in part).map(part => part.ref)
}

/**
 * Substitute parsed parts. Unknown name → `secret not found: NAME`.
 * @param {Array<{literal: string} | {ref: string}>} parts
 * @param {(name: string) => string | undefined} lookup
 */
export function render(parts, lookup) {
  let out = ''
  for (const part of parts) {
    if ('literal' in part) out += part.literal
    else {
      const value = lookup(part.ref)
      if (value === undefined) throw new Error(`secret not found: ${part.ref}`)
      out += value
    }
  }
  return out
}
