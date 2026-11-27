#!/usr/bin/env python3
"""Headless runner: let a coding agent's command-line version take dsh-hub tasks with nobody
at the keyboard (Claude Code `claude -p`, Antigravity `agy -p`, Codex `codex exec`, opencode ...).

Every `every` seconds it asks the hub whether there is work for this agent (GET /v1/peek:
takes nothing, costs no model tokens). Only when there is, it starts the agent's command
with a fixed prompt: take a task with next_task, do it within task.local.rules, hand it in
with submit_result. The agent reaches the hub through the same local MCP bridge
(mcp_bridge.py) it uses in an IDE, so it works under its own identity and grant (`can`).
After the run it reads what the run cost from the command's JSON output and reports it
(POST /v1/usage), which counts toward the agent's daily quota (hub.json `quota`).

Configuration: agents/<id>.json of the worker folder, key "runner":

    "runner": {
      "every": 120,                                   # seconds between checks (60..86400)
      "command": ["claude", "-p", "{prompt}", "--output-format", "json",
                  "--mcp-config", "/path/to/mcp.json", "--allowedTools", "mcp__dsh-hub"],
      "cwd": "{workspace_path}",                      # optional: the task's workspace folder
      "timeout": 3600,                                # seconds one run may take
      "env": {"SOME_FLAG": "1"}                       # optional extra environment (no secrets here)
    }

Placeholders: {prompt}, {workspace_path} (folder of the first available task's workspace),
{agent_id}, {tasklog} (a file the bridge writes the task ids it hands out to; the runner
also sets DSH_BRIDGE_TASKLOG and DSH_AGENT for the bridge).

Usage it can read: Claude Code JSON (usage + total_cost_usd), OpenAI / Codex style JSONL
events with usage, Gemini-style stats.models.*.tokens. A command that prints none is held
by tasksPerDay / minutesPerDay only (the hub shows usage_reported false).

    python agent_runner.py --agent cc-mydesk            # run until stopped
    python agent_runner.py --agent cc-mydesk --once     # one check (for cron)
"""
import argparse, json, os, subprocess, sys, tempfile, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent_client as ac  # noqa: E402

PROMPT = ("你连着 dsh-hub（MCP 服务 dsh-hub）。调用 next_task 领一个任务；没有任务就直接结束。"
          "领到后先读 task.local.rules 和 task.boundary，只做 task.needs 里写的事，按 task.instruction 做；"
          "是流水线的一段（task.pipeline）就交 task.pipeline.required 里的文件，测试段和验收段把结论写在第一行。"
          "做完调用 submit_result；做不了调用 release_task；拿不准就 submit_result status partial 并写 needs_input。"
          "只做这一个任务，交完就结束。")
DEFAULT_EVERY = 120
DEFAULT_TIMEOUT = 3600


def log(message):
    print(f"agent_runner: {message}", file=sys.stderr, flush=True)


# --- usage from a command's output ------------------------------------------------------

def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0 else None


def _usage_dict(u, cost=None):
    """One usage-shaped dict (Claude / OpenAI field names) -> counts, or None."""
    if not isinstance(u, dict):
        return None
    out = {}
    for src, dst in (("input_tokens", "input_tokens"), ("prompt_tokens", "input_tokens"), ("output_tokens", "output_tokens"),
                     ("completion_tokens", "output_tokens"), ("cache_creation_input_tokens", "cache_creation_input_tokens"),
                     ("cache_read_input_tokens", "cache_read_input_tokens"), ("cached_input_tokens", "cache_read_input_tokens"),
                     ("total_tokens", "total_tokens")):
        n = _num(u.get(src))
        if n is not None:
            out[dst] = out.get(dst, 0) + n
    c = _num(cost) if cost is not None else _num(u.get("cost_usd") if "cost_usd" in u else u.get("total_cost_usd"))
    if c is not None:
        out["cost_usd"] = c
    return out or None


def _gemini_stats(obj):
    """Gemini CLI style: {"stats": {"models": {name: {"tokens": {"prompt", "candidates", "total", ...}}}}}."""
    models = ((obj.get("stats") or {}).get("models") or {}) if isinstance(obj.get("stats"), dict) else {}
    out = {}
    for m in models.values() if isinstance(models, dict) else []:
        t = m.get("tokens") if isinstance(m, dict) else None
        if not isinstance(t, dict):
            continue
        for src, dst in (("prompt", "input_tokens"), ("candidates", "output_tokens"), ("total", "total_tokens"), ("cached", "cache_read_input_tokens")):
            n = _num(t.get(src))
            if n is not None:
                out[dst] = out.get(dst, 0) + n
    return out or None


def _add(total, part):
    for k, v in part.items():
        total[k] = (total.get(k, 0) + v) if k != "model" else v
    return total


def usage_of_output(text):
    """What one run cost, from the command's stdout (one JSON document, or JSON lines), or None."""
    docs = []
    text = (text or "").strip()
    if not text:
        return None
    try:
        doc = json.loads(text)
        docs = doc if isinstance(doc, list) else [doc]
    except ValueError:
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    docs.append(json.loads(line))
                except ValueError:
                    continue
    total = {}
    final = None
    for d in docs:
        if not isinstance(d, dict):
            continue
        # Claude Code: the final {"type": "result", "usage": ..., "total_cost_usd": ...} has the whole run.
        if d.get("type") == "result" and isinstance(d.get("usage"), dict):
            final = _usage_dict(d["usage"], d.get("total_cost_usd"))
            if isinstance(d.get("model"), str):
                final = {**(final or {}), "model": d["model"]}
            continue
        g = _gemini_stats(d)
        if g:
            _add(total, g)
            continue
        u = d.get("usage") if isinstance(d.get("usage"), dict) else (d.get("msg", {}) or {}).get("usage") if isinstance(d.get("msg"), dict) else None
        part = _usage_dict(u, d.get("total_cost_usd"))
        if part:
            _add(total, part)
    result = final or total
    return result or None


# --- the runner -------------------------------------------------------------------------

def runner_config(config_path):
    """agents/<id>.json "runner" -> checked dict."""
    try:
        with open(config_path, encoding="utf-8") as f:
            raw = json.load(f).get("runner")
    except (OSError, ValueError) as e:
        raise ac.ConfigError(f"{config_path}: {e}")
    if not isinstance(raw, dict):
        raise ac.ConfigError(f"{config_path}: no \"runner\" object (see agent_runner.py --help)")
    cmd = raw.get("command")
    if not isinstance(cmd, list) or not cmd or any(not isinstance(x, str) for x in cmd):
        raise ac.ConfigError(f"{config_path}: runner.command must be a list of strings")
    if not any("{prompt}" in x for x in cmd):
        raise ac.ConfigError(f"{config_path}: runner.command must contain {{prompt}}")
    every = raw.get("every", DEFAULT_EVERY)
    timeout = raw.get("timeout", DEFAULT_TIMEOUT)
    if not isinstance(every, int) or isinstance(every, bool) or not 60 <= every <= 86400:
        raise ac.ConfigError(f"{config_path}: runner.every must be 60..86400 seconds")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 60 <= timeout <= 86400:
        raise ac.ConfigError(f"{config_path}: runner.timeout must be 60..86400 seconds")
    env = raw.get("env") or {}
    if not isinstance(env, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in env.items()):
        raise ac.ConfigError(f"{config_path}: runner.env must be an object of strings")
    cwd = raw.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        raise ac.ConfigError(f"{config_path}: runner.cwd must be a string")
    return {"command": cmd, "every": every, "timeout": timeout, "env": env, "cwd": cwd}


class Runner:
    def __init__(self, client, workspaces, cfg, run=subprocess.run, sleep=time.sleep, clock=time.time):
        self.client, self.workspaces, self.cfg = client, dict(workspaces), cfg
        self.run_cmd, self.sleep, self.clock = run, sleep, clock

    def once(self):
        """One check: heartbeat, peek, and when there is work one run of the agent. Returns what happened."""
        try:
            self.client.heartbeat("idle", running=None)
            peek = self.client.peek()
        except (ac.HubError, OSError) as e:
            log(f"hub not reachable: {e}")
            return {"ran": False, "why": "hub"}
        if peek.get("over_quota"):
            log("over today's quota: not starting the agent")
            return {"ran": False, "why": "quota"}
        if not peek.get("available"):
            return {"ran": False, "why": "no-task"}
        first = (peek.get("tasks") or [{}])[0]
        ws_path = self.workspaces.get(first.get("workspace")) if first.get("workspace") else None
        fd, tasklog = tempfile.mkstemp(prefix="dsh-runner-", suffix=".tasks")
        os.close(fd)
        try:
            subst = {"{prompt}": PROMPT, "{workspace_path}": ws_path or "", "{agent_id}": self.client.agent_id, "{tasklog}": tasklog}

            def fill(s):
                for k, v in subst.items():
                    s = s.replace(k, v)
                return s
            argv = [fill(x) for x in self.cfg["command"]]
            cwd = fill(self.cfg["cwd"]) if self.cfg.get("cwd") else None
            if cwd == "":
                cwd = None
            env = {**os.environ, **self.cfg["env"], "DSH_BRIDGE_TASKLOG": tasklog, "DSH_AGENT": self.client.agent_id}
            log(f"{peek.get('available')} task(s) waiting ({first.get('task_id')}); starting {os.path.basename(argv[0])}")
            started = self.clock()
            try:
                p = self.run_cmd(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=self.cfg["timeout"])
                out, code = p.stdout, p.returncode
            except subprocess.TimeoutExpired as e:
                out, code = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or ""), "timeout"
            except OSError as e:
                log(f"could not start the agent: {e}")
                return {"ran": False, "why": "start-failed"}
            took = round(self.clock() - started)
            try:
                with open(tasklog, encoding="utf-8") as f:
                    ids = [x.strip() for x in f if x.strip()]
            except OSError:
                ids = []
            usage = usage_of_output(out)
            log(f"run ended ({code}) after {took} s; tasks: {', '.join(ids) or '-'}; usage: {json.dumps(usage) if usage else 'not reported'}")
            if usage:
                try:
                    self.client.report_usage(usage, ids)
                except (ac.HubError, OSError) as e:
                    log(f"could not report usage: {e}")
            return {"ran": True, "code": code, "tasks": ids, "usage": usage}
        finally:
            try:
                os.unlink(tasklog)
            except OSError:
                pass

    def forever(self):
        while True:
            self.once()
            self.sleep(self.cfg["every"])


def main(argv=None):
    p = argparse.ArgumentParser(description="headless runner: start a coding agent's CLI only when dsh-hub has a task for it",
                                epilog=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--agent", help="agent id (agents/<id>.json); default DSH_AGENT or the only agent")
    p.add_argument("--worker-dir", help="default <DSH home>/worker")
    p.add_argument("--once", action="store_true", help="one check, then exit (for cron / systemd timers)")
    a = p.parse_args(argv)
    env = os.environ
    args = ["paths"] + (["--worker-dir", a.worker_dir] if a.worker_dir else []) + (["--agent", a.agent] if a.agent else [])
    pa = ac.build_parser().parse_args(args)
    wd = os.path.abspath(os.path.expanduser(a.worker_dir)) if a.worker_dir else ac.default_worker_dir(env)
    try:
        _dotenv, _agent, _src, wm, st = ac._resolve(pa, "paths", wd, env)
        ac.check_settings(st)
        cfg = runner_config(wm.config_path)
        token = ac.read_token(st["token_file"])
        client = ac.HubClient(st["url"], token, False, st["cafile"], 60, agent_id=st["agent_id"] or None,
                              proxy=st["proxy"], no_proxy=st["no_proxy"], workspaces=wm.names(), runtime=st.get("runtime"),
                              role=st.get("role"), pull_every_seconds=cfg["every"], dsh_profile=st.get("dsh_profile"), can=st.get("can"))
    except (ac.ConfigError, OSError) as e:
        log(f"error: {e}")
        return 2
    workspaces = {n: path for n, path in wm.workspaces.items() if n in wm.names()}
    runner = Runner(client, workspaces, cfg)
    log(f"{client.agent_id} -> {ac.mask_url(client.url)}; every {cfg['every']} s; command {os.path.basename(cfg['command'][0])}")
    if a.once:
        res = runner.once()
        print(json.dumps(res, ensure_ascii=False))
        return 0
    try:
        runner.forever()
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
