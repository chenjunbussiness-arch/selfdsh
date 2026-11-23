#!/bin/sh
# Demo worker container: register with the hub, then run the client loop plus a tiny
# executor that answers every task. All settings come from the environment
# (docker-compose.yml); the process environment wins over worker/.env.
set -eu

WD="$DSH_HOME/worker"
mkdir -p "$WD" "$DSH_EXCHANGE"

# profile.json: node + the local path of each workspace name (only names go to the hub).
if [ ! -s "$WD/profile.json" ]; then
  printf '{"node": "%s", "workspaces": {"sandbox": "/workspaces/sandbox"}}\n' "$DSH_NODE" > "$WD/profile.json"
fi

CLIENT=/opt/agent/agent_client.py
echo "== check =="
python "$CLIENT" check || echo "check failed (continuing; see the message above)"

echo "== register (waits until a controller approves: agent_requests / agent_approve in DSH) =="
python "$CLIENT" register

echo "== run =="
python /opt/demo/demo_executor.py &
exec python "$CLIENT" run
