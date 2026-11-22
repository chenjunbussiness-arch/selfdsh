#!/usr/bin/env bash
# Build host-router into lib.next/ and check it. Never touches the live lib/.
# DSH loads lib/ at boot; rewriting it while DSH runs can unload the plugin.
# lib.next/ is swapped into lib/ only by safe-restart.sh, while DSH is stopped.
set -euo pipefail
H="$(cd "$(dirname "$0")/../packages/host-router" && pwd)"
TSC="${DSH_TSC:-/srv/workspace/google tend/lumen-companion-harness/node_modules/typescript/bin/tsc}"
rm -rf "$H/lib.next"
node "$TSC" -p "$H/tsconfig.json" ${DSH_TYPE_ROOTS:+--typeRoots "$DSH_TYPE_ROOTS"}
# Must be ESM: the package is "type": "module". A CommonJS build fails at import.
if head -c 200 "$H/lib.next/index.js" | grep -q '"use strict"'; then
  echo "safe-build: lib.next/index.js is CommonJS, refusing" >&2; exit 1
fi
node --input-type=module -e "const m = await import('$H/lib.next/index.js'); if (typeof m.apply !== 'function') throw new Error('no apply export'); console.log('safe-build: import ok')"
# Run the tests that do not depend on the old fixtures against lib.next.
T=$(mktemp -d); ln -s "$H/lib.next" "$T/lib"; cp "$H/package.json" "$T/"; mkdir "$T/tests"
cp "$H/tests/resume.test.mjs" "$H/tests/tier.test.mjs" "$T/tests/"
( cd "$T" && node --test tests/resume.test.mjs tests/tier.test.mjs )
rm -rf "$T"
echo "safe-build: lib.next ready; run safe-restart.sh to switch to it"
