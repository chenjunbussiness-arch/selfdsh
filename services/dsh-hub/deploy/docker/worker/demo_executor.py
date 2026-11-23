#!/usr/bin/env python3
"""Demo executor for the docker worker: answers every task in the exchange folder.

agent_client.py `run` writes each leased task to  inbox/<task_id>/task.json  and
uploads whatever appears in  outbox/<task_id>/  once result.json is there. This
script plays the "agent" in between, so the loop can be tested without a real one:

  inbox/<id>  --move-->  working/<id>   (accepted; the client keeps renewing the lease)
  writes outbox/<id>/summary.md, then outbox/<id>/result.json LAST

summary.md echoes the task and lists the workspace folder, which shows that the
workspace name was mapped to this container's local path (workspace_path).
Standard library only.
"""
import json
import os
import shutil
import sys
import time

ROOT = os.environ.get("DSH_EXCHANGE", "/worker-home/exchange")
INTERVAL = float(os.environ.get("DEMO_INTERVAL_SECONDS", "3"))


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def listing(path, limit=20):
    if not path or not os.path.isdir(path):
        return f"(workspace_path {path!r} is not a folder in this container)"
    names = sorted(os.listdir(path))
    shown = "\n".join(f"- {n}" for n in names[:limit]) or "(empty)"
    more = f"\n- ... {len(names) - limit} more" if len(names) > limit else ""
    return shown + more


def handle(tid):
    src = os.path.join(ROOT, "inbox", tid)
    work = os.path.join(ROOT, "working", tid)
    out = os.path.join(ROOT, "outbox", tid)
    if os.path.exists(out) or os.path.exists(os.path.join(ROOT, "archive", tid)):
        return
    try:
        os.replace(src, work)
    except OSError:
        return  # already taken, or the client is still writing it
    with open(os.path.join(work, "task.json"), encoding="utf-8") as f:
        task = json.load(f)
    os.makedirs(out, exist_ok=True)
    summary = "\n".join([
        f"# {task.get('title', tid)}",
        "",
        f"- task_id: {tid}",
        f"- type: {task.get('type')}",
        f"- workspace: {task.get('workspace')} -> {task.get('workspace_path')}",
        f"- node: {task.get('node')}",
        f"- created_by: {task.get('created_by')}",
        f"- attempt: {task.get('attempt')}",
        "",
        "## instruction",
        "",
        str(task.get("instruction", "")),
        "",
        "## workspace contents",
        "",
        listing(task.get("workspace_path")),
        "",
        f"_answered by the docker demo executor at {time.strftime('%Y-%m-%d %H:%M:%S')}_",
        "",
    ])
    write_atomic(os.path.join(out, "summary.md"), summary)
    result = {"status": "completed",
              "summary": f"docker demo worker received '{task.get('title', tid)}' "
                         f"(workspace {task.get('workspace')} -> {task.get('workspace_path')})"}
    write_atomic(os.path.join(out, "result.json"), json.dumps(result, ensure_ascii=False))
    shutil.rmtree(work, ignore_errors=True)
    print(f"demo-executor: answered {tid}", flush=True)


def main():
    print(f"demo-executor: watching {ROOT}/inbox every {INTERVAL:g}s", flush=True)
    for box in ("inbox", "working", "outbox"):
        os.makedirs(os.path.join(ROOT, box), exist_ok=True)
    while True:
        try:
            for tid in sorted(os.listdir(os.path.join(ROOT, "inbox"))):
                if tid.startswith(".") or not os.path.isfile(os.path.join(ROOT, "inbox", tid, "task.json")):
                    continue
                try:
                    handle(tid)
                except Exception as error:  # keep the demo alive; the lease will expire and requeue
                    print(f"demo-executor: {tid} failed: {error}", file=sys.stderr, flush=True)
        except FileNotFoundError:
            os.makedirs(os.path.join(ROOT, "inbox"), exist_ok=True)
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
