/**
 * Forgiving input helpers for the panel's text fields.
 *
 * People paste what they have at hand: a full endpoint URL into "add host", or a
 * whole proxy URL into the proxy host field. These helpers turn that into the
 * fields the bridge expects, so the paste just works instead of coming back as
 * "not a valid host name". The host still validates everything it receives.
 */

/**
 * The host name in what someone typed or pasted into "add host".
 *
 * `https://api.example.com/v1/chat` → `api.example.com`,
 * `api.example.com:443` → `api.example.com`, `[::1]:8080` → `::1`.
 * Anything that does not parse is returned trimmed and lower-cased, so the
 * host's own validation still gets the final word.
 * @param raw - the field's text.
 * @returns the host to bind.
 */
export function hostFromInput(raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  try {
    const host = new URL(withScheme).hostname
    if (host !== '') return host.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    // Not a URL shape: hand it on as typed.
  }
  return text.toLowerCase()
}

/** Proxy fields recovered from a pasted proxy URL. */
export interface ProxyPaste {
  readonly type?: 'http' | 'https' | 'socks5'
  readonly host: string
  readonly port?: string
  readonly username?: string
  readonly password?: string
}

/**
 * Split a pasted proxy address into the form's fields.
 *
 * `socks5://user:pass@proxy.example.com:1080` → type, host, port and auth;
 * `proxy.example.com:3128` → host and port. Returns `undefined` when the text is
 * a plain host name, so typing one character at a time is never rewritten.
 * @param raw - the host field's text.
 * @returns the recovered fields, or `undefined` when there is nothing to split.
 */
export function parseProxyInput(raw: string): ProxyPaste | undefined {
  const text = raw.trim()
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const hasPort = /:[0-9]{1,5}\/?$/.test(text) && !/^[0-9a-f:]+$/i.test(text)
  if (!hasScheme && !hasPort && !text.includes('@')) return undefined
  let url: URL
  try {
    url = new URL(hasScheme ? text : `http://${text}`)
  } catch {
    return undefined
  }
  if (url.hostname === '') return undefined
  const scheme = url.protocol.replace(/:$/, '').toLowerCase()
  const type = scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks' ? 'socks5'
    : scheme === 'https' ? 'https'
      : scheme === 'http' ? 'http' : undefined
  return {
    ...hasScheme && type !== undefined ? { type } : {},
    host: url.hostname.replace(/^\[|\]$/g, ''),
    ...url.port === '' ? {} : { port: url.port },
    ...url.username === '' ? {} : { username: decodeURIComponent(url.username) },
    ...url.password === '' ? {} : { password: decodeURIComponent(url.password) },
  }
}
