"""Run the dsh-hub worker (agent_client.py run) under pythonw.exe with backoff supervision.

Started by start-worker.ps1 through Win32_Process.Create: no console window, no
handles inherited from the shell that started it, so the launcher returns at once
and the worker keeps running after that shell / DSH session is gone.

All output (the client logs to stderr) is appended to <worker>/run.log.
"""
import datetime
import os
import sys
import time

WORKER_DIR = os.path.join(os.path.abspath(os.path.expanduser(os.environ.get("DSH_HOME") or "~/.dsh")), "worker")
CLIENT_DIR = os.path.dirname(os.path.abspath(__file__))

os.makedirs(WORKER_DIR, exist_ok=True)
log = open(os.path.join(WORKER_DIR, "run.log"), "a", encoding="utf-8", buffering=1)
sys.stdout = log
sys.stderr = log
if CLIENT_DIR not in sys.path:
    sys.path.insert(0, CLIENT_DIR)

import agent_client  # noqa: E402  (path set up above on purpose)


def run_supervised(argv=("run",), sleep=time.sleep):
    backoff = 10
    while True:
        ts = datetime.datetime.now().isoformat(timespec="seconds")
        print(f"\n=== worker_run.py starting pid={os.getpid()} at {ts} ===", flush=True)
        try:
            code = agent_client.main(list(argv))
        except KeyboardInterrupt:
            print("worker_run.py stopped by KeyboardInterrupt", flush=True)
            return 0
        except Exception as err:  # noqa: BLE001
            print(f"worker_run.py unexpected error: {err}; restarting in {backoff} s", flush=True)
            sleep(backoff)
            backoff = min(60, backoff * 2)
            continue
        if code == 0:
            return 0
        if code == 2:
            print("worker_run.py config/local error (exit 2); stopping", flush=True)
            return code
        print(f"worker_run.py agent_client exited with {code}; retrying in {backoff} s", flush=True)
        sleep(backoff)
        backoff = min(60, backoff * 2)


if __name__ == "__main__":
    sys.exit(run_supervised())
