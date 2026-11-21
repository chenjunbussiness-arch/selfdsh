#!/usr/bin/env node
// Stand-in for openfortivpn. Never touches the network, routes or DNS.
// FAKE_MODE: ok (default) | authfail | cert | crash | hang
// FAKE_SECRET_ECHO=1 makes it print the password / cookie it received, so tests can prove redaction.
import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const mode = process.env.FAKE_MODE ?? 'ok'

if (args.includes('--version')) { console.log('1.20.0'); process.exit(0) }
if (args.includes('--help')) { console.log('Usage: openfortivpn\n  --cookie-on-stdin  Read the cookie (SVPNCOOKIE) from standard input.'); process.exit(0) }

const say = (line) => console.log(line)
let secret = ''
const at = args.indexOf('-c')
if (at >= 0 && args[at + 1]) {
  const text = readFileSync(args[at + 1], 'utf8')
  secret = /^password = (.*)$/m.exec(text)?.[1] ?? ''
}
if (args.includes('--cookie-on-stdin')) {
  secret = await new Promise((resolve) => {
    let data = ''
    process.stdin.on('data', (chunk) => { data += chunk })
    process.stdin.on('end', () => resolve(data.trim()))
  })
}
// Record the argv so a test can assert on it (no secret is in argv by construction).
say(`ARGV ${JSON.stringify(args)}`)
say('INFO:   Connected to gateway.')
if (process.env.FAKE_SECRET_ECHO === '1') say(`DEBUG:  using credential ${secret} and password=${secret}`)
if (mode === 'authfail') { say('ERROR:  Could not authenticate to gateway. Please check the username and password.'); process.exit(1) }
if (mode === 'cert') { say('ERROR:  Gateway certificate validation failed, and the certificate digest is not in the local whitelist. If you trust it, rerun with:\nERROR:      --trusted-cert ' + 'ab'.repeat(32)); process.exit(1) }
if (mode === 'crash') { setTimeout(() => process.exit(7), 100); }
if (mode !== 'hang') {
  say('INFO:   Authenticated.')
  say('INFO:   Remote gateway has allocated a VPN.')
  say('INFO:   Interface ppp0 is UP.')
  say('INFO:   Got addresses: [10.8.0.6], ns [10.8.0.1, 0.0.0.0]')
  say('INFO:   Tunnel is up and running.')
}
process.on('SIGTERM', () => { say('INFO:   Cancelling threads...'); say('INFO:   Tunnel closed.'); process.exit(0) })
process.on('SIGINT', () => process.exit(0))
setInterval(() => {}, 1000)
