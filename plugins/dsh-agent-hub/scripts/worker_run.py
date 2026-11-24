"""Run the dsh-hub worker (agent_client.py run) under pythonw.exe with backoff supervision.

Started by start-worker.ps1 through Win32_Process.Create: no console window, no
handles inherited from the shell that started it, so the launcher returns at once
and the worker keeps running after that shell / DSH session is gone.

    pythonw worker_run.py [--agent <id>] [--worker-dir <dir>]

The agent is chosen exactly as `agent_client.py run` chooses it (--agent, DSH_AGENT,
or the only file in <DSH home>/worker/agents/). All output (the client logs to stderr)
is appended to that agent's log: <worker>/logs/<agent>.log (older single-agent
folders: <worker>/run.log).
"""
import argparse
import datetime
import os
import sys
import time

CLIENT_DIR = os.path.dirname(os.path.abspath(__file__))
if CLIENT_DIR not in sys.path:
    sys.path.insert(0, CLIENT_DIR)

import agent_client  # noqa: E402  (path set up above on purpose)


def parse_args(argv):
    p = argparse.ArgumentParser(description="supervise agent_client.py run")
    p.add_argument("--agent", default=None)
    p.add_argument("--worker-dir", default=None)
    return p.parse_args(argv)


def client_argv(args):
    out = ["run"]
    if args.worker_dir:
        out += ["--worker-dir", args.worker_dir]
    if args.agent:
        out += ["--agent", args.agent]
    return out


def log_path(args, env=None):
    """The selected agent's log file; <worker>/run.log when the settings cannot be read (the client
    then says why in that log and stops)."""
    try:
        return agent_client.resolve_files(args.worker_dir, args.agent, env)["log_file"]
    except Exception:  # noqa: BLE001 -- the log must open whatever is wrong with the config
        wd = os.path.abspath(os.path.expanduser(args.worker_dir)) if args.worker_dir else agent_client.default_worker_dir(env)
        return os.path.join(wd, "run.log")


def run_supervised(argv=("run",), sleep=time.sleep):
    backoff = 10
    while True:
        ts = datetime.datetime.now().isoformat(timespec="seconds")
        print(f"\n=== worker_run.py starting pid={os.getpid()} at {ts}: {' '.join(argv)} ===", flush=True)
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


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    path = log_path(args)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    log = open(path, "a", encoding="utf-8", buffering=1)
    sys.stdout = log
    sys.stderr = log
    return run_supervised(client_argv(args))


if __name__ == "__main__":
    sys.exit(main())
