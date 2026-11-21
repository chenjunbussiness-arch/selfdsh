#!/usr/bin/env bash
# Restart DSH without losing work:
#  1. wait (up to WAIT_MIN minutes) for running tasks to finish, unless --now;
#  2. stop DSH; in-flight rows are filed as "interrupted";
#  3. if lib.next/ exists and passed safe-build, swap it into lib/ (old lib kept as lib.prev/);
#  4. start DSH; the router resumes interrupted rows in their own sessions from their logs;
#  5. check the router API, and roll back to lib.prev/ if the plugin failed to load.
set -euo pipefail
H="$(cd "$(dirname "$0")/../packages/host-router" && pwd)"
BOARD=/root/.dsh/router/board.json
WAIT_MIN="${WAIT_MIN:-10}"
active() { python3 -c "import json;d=json.load(open('$BOARD'));t=d.get('tasks',d);print(sum(1 for x in t if x.get('state') in ('running','dispatched')))"; }
if [[ "${1:-}" != "--now" ]]; then
  for ((i=0; i<WAIT_MIN*6; i++)); do
    n=$(active); [[ "$n" == "0" ]] && break
    echo "safe-restart: $n task(s) running, waiting ($((i*10))s)"; sleep 10
  done
  echo "safe-restart: $(active) task(s) still running; they will be resumed after the restart"
fi
systemctl stop dsh-web.service
if [[ -d "$H/lib.next" ]]; then
  rm -rf "$H/lib.prev"; mv "$H/lib" "$H/lib.prev"; mv "$H/lib.next" "$H/lib"
  echo "safe-restart: switched to the new build (previous kept in lib.prev/)"
fi
systemctl start dsh-web.service
ok=0
for i in $(seq 1 30); do
  sleep 3
  T=$(grep -o 'token=[A-Za-z0-9_-]*' /var/log/dsh-web.log | tail -1 | cut -d= -f2)
  J=$(mktemp); curl -s -o /dev/null -c "$J" -b "$J" -L "http://127.0.0.1:42443/?token=$T" || true
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$J" http://127.0.0.1:42443/api/router/board || true); rm -f "$J"
  if [[ "$code" == "200" ]]; then ok=1; break; fi
done
if [[ $ok == 1 ]]; then echo "safe-restart: router up"; exit 0; fi
echo "safe-restart: router did not come up" >&2
if [[ -d "$H/lib.prev" ]]; then
  echo "safe-restart: rolling back to lib.prev/" >&2
  systemctl stop dsh-web.service; rm -rf "$H/lib.failed"; mv "$H/lib" "$H/lib.failed"; mv "$H/lib.prev" "$H/lib"; systemctl start dsh-web.service
fi
exit 1
