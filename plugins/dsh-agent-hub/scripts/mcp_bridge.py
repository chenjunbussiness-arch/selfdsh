#!/usr/bin/env python3
"""mcp_bridge.py -- one local stdio MCP server for every MCP-capable coding agent
(Antigravity / Gemini, Claude Code, Codex, ...): it lets the agent take hub tasks
with the hub's own five MCP tools (next_task, get_input, report_progress,
submit_result, release_task).

Why a local bridge instead of pointing the agent at https://<hub>/mcp directly:
  - the hub certificate is usually self-signed (DSH_HUB_CAFILE) and the hub is often
    reached through a local HTTP proxy (DSH_HUB_PROXY); IDE MCP clients handle neither;
  - the hub's /mcp wants a 15 minute bearer from POST /oauth/token
    (client_credentials); the bridge gets and renews it itself, so the agent never
    sees the worker token or a bearer;
  - the hub counts a worker offline after ~90 s of silence and requeues its task.
    A model that edits code for 20 minutes says nothing in between, so the bridge
    keeps every task it handed out alive (a lease renew every 30 s) until the agent
    calls submit_result or release_task. It sends nothing while it holds no task, so
    an idle IDE does not look like a worker that is waiting for work.

Settings come from the same worker folder as agent_client.py (it must sit next to
this file): <DSH home>/worker/.env (DSH_HUB_URL, DSH_HUB_PROXY, DSH_HUB_CAFILE),
agents/<id>.json (dshProfile, role, capabilities, workspaces ...) and
tokens/<id>.token (written by `agent_client.py register`).

What the bridge adds to the hub tools (all local, nothing extra leaves the machine):
  - next_task: a heartbeat first (workspace names, role, profile), so tasks bound to
    a workspace of this machine reach this agent; the task comes back with a `local`
    block: workspace_path (the folder to edit), current_branch when the task names a
    ref, and the rules of this agent's role;
  - submit_result: for a coder whose task has a local workspace, `changes.patch`
    (read-only `git diff` of the workspace) is attached when the agent did not send
    one, so the test + git step that follows gets it as its input (--no-patch: off);
  - report_progress: answers to the agent's questions that arrived with a keep-alive
    are handed over here, never dropped.

Usage (MCP config of the agent; stdio):
  python mcp_bridge.py --agent agy-mydesk          # DSH_AGENT / the only agents/*.json also work
  python mcp_bridge.py --agent agy-mydesk --check  # one token + tools/list round trip, then exit

Logs go to stderr (the MCP client shows them); stdout carries only MCP messages.
"""
import argparse, json, os, subprocess, sys, threading, time, urllib.error, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agent_client as ac  # noqa: E402

BRIDGE_VERSION = "mcp_bridge/1.0.0"
KEEPALIVE_SECONDS = 30
REFRESH_MARGIN_SECONDS = 60
MAX_PATCH_BYTES = 2 * 1024 * 1024
PATCH_NAME = "changes.patch"

ROLE_RULES = {
    "coder": ("你在这个调度里的角色是 coder：只改代码。"
              "不要跑测试、不要执行命令或脚本、不要碰 git（不提交、不推送、不切分支），也不要\"顺手验证一下\"。"
              "改完调用 submit_result：status completed，summary 写清改了哪些文件、为什么改；"
              "changes.patch 由本机桥自动生成，不用自己写。"
              "测试和提交由 DSH 另派给本机的 dsh worker。拿不准就 submit_result status partial，把问题写在 needs_input。"),
    "tester": "你在这个调度里的角色是 tester：只跑测试，不改业务代码，不碰 git。",
}
CAN_WORDS = {"plan": "出方案和验收标准", "code": "改代码", "test": "跑测试", "git": "提交和推送（git）",
             "cmd": "执行其他命令", "review": "验收别人的改动"}


def can_rules(can):
    """The rule line of an agent that declared `can` (the hub's boundary in a task says the same)."""
    if can is None:
        return None
    may = "、".join(CAN_WORDS[c] for c in can if c in CAN_WORDS) or "（无）"
    never = "、".join(w for c, w in CAN_WORDS.items() if c not in can)
    return (f"你在这个调度里能做的是：{may}" + (f"；不能{never}" if never else "") + "。"
            "每个任务只做 task.needs 里写的那部分；流水线的段（task.pipeline）按 task.pipeline.required 交文件，"
            "测试段和验收段把结论写在第一行。")


GENERAL_RULES = ("在 task.local.workspace_path 指向的文件夹里工作，不要改它以外的文件。"
                 "做不了就调用 release_task 并写明原因。")


def log(message):
    print(f"mcp_bridge: {message}", file=sys.stderr, flush=True)


class BridgeError(Exception):
    pass


class HubMcp:
    """The hub's /mcp, with a bearer from /oauth/token that is renewed before it runs out."""

    def __init__(self, client, clock=time.time):
        self.client = client
        self.clock = clock
        base = client.url.rstrip("/")
        self.root = base[: -len(ac.API_PREFIX)] if base.endswith(ac.API_PREFIX) else base
        self.bearer = None
        self.bearer_until = 0.0
        self.session_id = None
        self.protocol_version = None
        self.lock = threading.Lock()

    def _open(self, req, timeout=60):
        return self.client.opener.open(req, timeout=timeout)

    def token(self, force=False):
        with self.lock:
            if not force and self.bearer and self.clock() < self.bearer_until - REFRESH_MARGIN_SECONDS:
                return self.bearer
            body = json.dumps({"grant_type": "client_credentials", "client_id": self.client.agent_id,
                               "client_secret": self.client.token}).encode("utf-8")
            req = urllib.request.Request(self.root + "/oauth/token", data=body, method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("Accept", "application/json")
            req.add_header("User-Agent", BRIDGE_VERSION)
            try:
                with self._open(req) as res:
                    out = json.loads(res.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                try:
                    err = json.loads(e.read().decode("utf-8"))
                except Exception:
                    err = {}
                raise BridgeError(f"/oauth/token {e.code}: {err.get('error', 'http')} {err.get('error_description', e.reason)}") from None
            self.bearer = out["access_token"]
            self.bearer_until = self.clock() + int(out.get("expires_in", 900))
            return self.bearer

    def post(self, message):
        """One JSON-RPC message (or batch) -> the parsed answer, or None (202, notification only)."""
        data = json.dumps(message, ensure_ascii=False).encode("utf-8")
        for attempt in (1, 2):
            req = urllib.request.Request(self.root + "/mcp", data=data, method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("Accept", "application/json, text/event-stream")
            req.add_header("User-Agent", BRIDGE_VERSION)
            req.add_header("Authorization", "Bearer " + self.token(force=attempt == 2))
            if self.session_id:
                req.add_header("Mcp-Session-Id", self.session_id)
            if self.protocol_version:
                req.add_header("MCP-Protocol-Version", self.protocol_version)
            try:
                with self._open(req) as res:
                    sid = res.headers.get("Mcp-Session-Id")
                    if sid:
                        self.session_id = sid
                    raw = res.read()
                    if res.status == 202 or not raw.strip():
                        return None
                    return json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt == 1:
                    continue  # bearer expired or the hub restarted: get a new one once
                try:
                    detail = json.loads(e.read().decode("utf-8")).get("error", {})
                    detail = detail.get("message") if isinstance(detail, dict) else detail
                except Exception:
                    detail = e.reason
                raise BridgeError(f"hub /mcp {e.code}: {detail}") from None
        raise BridgeError("hub /mcp 401: the worker token was refused (revoked? run agent_client.py status)")


def tool_value(result):
    """The JSON value inside a hub tool result, or None (error / not JSON)."""
    if not isinstance(result, dict) or result.get("isError"):
        return None
    if isinstance(result.get("structuredContent"), dict):
        return result["structuredContent"]
    try:
        return json.loads(result["content"][0]["text"])
    except Exception:
        return None


def tool_result(value):
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "structuredContent": value}


def git(ws, *args, ok=(0,)):
    """Read-only git in a workspace -> stdout bytes, or None."""
    try:
        p = subprocess.run(["git", "-C", ws, *args], capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return p.stdout if p.returncode in ok else None


def workspace_patch(ws):
    """(patch text, note). Tracked changes against HEAD plus untracked files, all read-only."""
    if git(ws, "rev-parse", "--is-inside-work-tree") is None:
        return None, "工作区不是 git 仓库，没有生成 changes.patch"
    parts = [git(ws, "diff", "--binary", "HEAD") or b""]
    others = git(ws, "ls-files", "--others", "--exclude-standard", "-z") or b""
    for name in [n for n in others.decode("utf-8", "replace").split("\0") if n]:
        # --no-index exits 1 when the files differ, which they always do here
        parts.append(git(ws, "diff", "--binary", "--no-index", "--", "/dev/null", name, ok=(0, 1)) or b"")
    patch = b"".join(parts)
    if not patch.strip():
        return None, "工作区没有改动，没有生成 changes.patch"
    if len(patch) > MAX_PATCH_BYTES:
        return None, f"改动太大（{len(patch)} 字节），没有附 changes.patch，改动留在本机工作区"
    # Which commit the patch is against, so whoever tests or commits it starts from the same place
    # (git apply skips text before the first diff).
    head = (git(ws, "rev-parse", "HEAD") or b"").decode().strip()
    branch = (git(ws, "rev-parse", "--abbrev-ref", "HEAD") or b"").decode().strip()
    header = f"# base: {head} ({branch})\n" if head else ""
    return header + patch.decode("utf-8", "replace"), None


class Bridge:
    def __init__(self, client, hub, workspaces, role, out, keepalive=KEEPALIVE_SECONDS, make_patch=True, can=None, tasklog=None):
        self.client, self.hub = client, hub
        self.workspaces = dict(workspaces)  # name -> local path
        self.role = role or "worker"
        self.can = can
        self.tasklog = tasklog  # a headless runner reads which tasks this run took (for /v1/usage)
        self.out = out
        self.keepalive = keepalive
        self.make_patch = make_patch
        self.held = {}      # task_id -> {"attempt", "workspace", "dirty_before"}
        self.answers = {}   # task_id -> [answers that arrived with a keep-alive]
        self.lock = threading.Lock()
        self.stop = threading.Event()

    # --- keep-alive -------------------------------------------------------------------
    def start(self):
        threading.Thread(target=self._keepalive_loop, name="keepalive", daemon=True).start()

    def _keepalive_loop(self):
        while not self.stop.wait(self.keepalive):
            self.renew_all()

    def renew_all(self):
        with self.lock:
            held = dict(self.held)
        for task_id, h in held.items():
            try:
                res = self.client.progress(task_id, renew=True, attempt=h.get("attempt"))
                self._keep_answers(task_id, res.get("answers"))
            except ac.HubError as e:
                if e.status in (404, 409):
                    log(f"{task_id} is no longer ours ({e.code}); stopped keeping it alive")
                    with self.lock:
                        self.held.pop(task_id, None)
                else:
                    log(f"keep-alive of {task_id} failed: {e}")
            except OSError as e:
                log(f"keep-alive of {task_id} failed: {e}")

    def _keep_answers(self, task_id, answers):
        if answers:
            with self.lock:
                self.answers.setdefault(task_id, []).extend(answers)

    # --- MCP --------------------------------------------------------------------------
    def rules(self):
        own = can_rules(self.can) if self.can is not None else ROLE_RULES.get(self.role)
        return " ".join(x for x in (own, GENERAL_RULES) if x)

    def instructions(self, hub_text):
        rules = self.rules()
        return f"{hub_text or ''}\n{rules}".strip()

    def handle(self, message):
        """One message from the agent -> the answer to write back (None for a notification)."""
        if isinstance(message, list):
            out = [r for r in (self.handle(m) for m in message) if r is not None]
            return out or None
        if not isinstance(message, dict):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
        method = message.get("method")
        mid = message.get("id")
        try:
            if method == "tools/call":
                return self.call(message)
            answer = self.hub.post(message)
            if method == "initialize" and isinstance(answer, dict) and isinstance(answer.get("result"), dict):
                r = answer["result"]
                self.hub.protocol_version = r.get("protocolVersion")
                r["instructions"] = self.instructions(r.get("instructions"))
                r["serverInfo"] = {"name": "dsh-hub (via mcp_bridge)", "version": BRIDGE_VERSION}
            return answer
        except (BridgeError, OSError, ac.HubError) as e:
            log(str(e))
            if "id" not in message:
                return None
            return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32000, "message": f"dsh-hub 连不上：{e}"}}

    def call(self, message):
        params = message.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        task_id = args.get("task_id")
        if name == "next_task":
            self.heartbeat()
        if name == "submit_result" and self.make_patch:
            args = self.with_patch(task_id, args)
            message = {**message, "params": {**params, "arguments": args}}
        answer = self.hub.post(message)
        result = answer.get("result") if isinstance(answer, dict) else None
        value = tool_value(result)
        if value is None:
            return answer
        if name == "next_task" and isinstance(value.get("task"), dict):
            value["task"]["local"] = self.take(value["task"])
            answer["result"] = tool_result(value)
        elif name in ("submit_result", "release_task"):
            with self.lock:
                self.held.pop(task_id, None)
                self.answers.pop(task_id, None)
        elif name == "report_progress":
            with self.lock:
                kept = self.answers.pop(task_id, [])
            if kept:
                value["answers"] = kept + list(value.get("answers") or [])
                answer["result"] = tool_result(value)
        return answer

    def heartbeat(self):
        """Report this machine's workspaces (and role / profile) so workspace-bound tasks can reach it.
        No `running` list: the hub must not reconcile against what this bridge happens to hold."""
        try:
            res = self.client.heartbeat("idle", running=None)
            for a in res.get("answers") or []:
                self._keep_answers(a.get("task_id"), [{k: v for k, v in a.items() if k != "task_id"}])
        except (ac.HubError, OSError) as e:
            log(f"heartbeat failed: {e}")

    def take(self, task):
        """A task the agent just got: keep it alive and tell the agent where to work."""
        ws_name = task.get("workspace")
        path = self.workspaces.get(ws_name) if ws_name else None
        # The hub's boundary (what this agent may do, from its grant) comes first when the hub sends one.
        boundary = task.get("boundary") if isinstance(task.get("boundary"), str) else None
        local = {"role": self.role, "rules": " ".join(x for x in (boundary or self.rules(), GENERAL_RULES if boundary else None) if x)}
        if self.can is not None:
            local["can"] = list(self.can)
        needs = task.get("needs") if isinstance(task.get("needs"), list) else None
        coding = self.role == "coder" if needs is None else "code" in needs
        dirty = False
        if ws_name and path:
            local["workspace_path"] = path
            if task.get("ref"):
                branch = git(path, "rev-parse", "--abbrev-ref", "HEAD")
                local["current_branch"] = branch.decode().strip() if branch else None
                no_git = self.role == "coder" if self.can is None else "git" not in self.can
                local["ref_note"] = ("任务指定了 ref，你不碰 git、不切分支；当前分支不是它时用 release_task 退回。"
                                     if no_git else "任务指定了 ref，先确认工作区在这个分支上。")
            status = git(path, "status", "--porcelain")
            dirty = bool(status and status.strip())
            if dirty:
                local["note"] = "领活时工作区已有未提交的改动，交的 changes.patch 会包含它们。"
        elif ws_name:
            local["note"] = f"工作区 {ws_name} 不在这台机器上，用 release_task 退回。"
        with self.lock:
            self.held[task["task_id"]] = {"attempt": task.get("attempt"), "workspace": ws_name, "dirty_before": dirty, "coding": coding}
        if self.tasklog:
            try:
                with open(self.tasklog, "a", encoding="utf-8") as f:
                    f.write(task["task_id"] + "\n")
            except OSError as e:
                log(f"could not write the task log: {e}")
        return local

    def with_patch(self, task_id, args):
        files = args.get("files") if isinstance(args.get("files"), list) else []
        if args.get("status") != "completed" or any(isinstance(f, dict) and f.get("name") == PATCH_NAME for f in files):
            return args
        with self.lock:
            h = self.held.get(task_id)
        path = self.workspaces.get(h["workspace"]) if h and h.get("workspace") else None
        # Only a task that edits code hands in its edit (a test or review stage leaves the workspace as it was).
        if not path or not h.get("coding", True):
            return args
        patch, note = workspace_patch(path)
        summary = str(args.get("summary") or "")
        if patch is None:
            log(f"{task_id}: {note}")
            return {**args, "summary": f"{summary}\n（{note}）".strip()}
        log(f"{task_id}: attached {PATCH_NAME} ({len(patch.encode('utf-8'))} bytes)")
        extra = f"\n（{PATCH_NAME} 由本机 mcp_bridge 从工作区 {h['workspace']} 生成；改动也留在这台机器的工作区里。）"
        return {**args, "summary": summary + extra, "files": files + [{"name": PATCH_NAME, "text": patch}]}

    # --- stdio ------------------------------------------------------------------------
    def write(self, answer):
        data = json.dumps(answer, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"
        self.out.write(data)
        self.out.flush()

    def serve(self, stdin):
        self.start()
        try:
            for raw in stdin:
                if not raw.strip():
                    continue
                try:
                    message = json.loads(raw.decode("utf-8-sig"))
                except ValueError:
                    self.write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
                    continue
                answer = self.handle(message)
                if answer is not None:
                    self.write(answer)
        finally:
            self.stop.set()


def load(agent=None, worker_dir=None, env=None):
    """(HubClient, workspace map name -> path, role) of the selected agent, from the worker folder."""
    env = os.environ if env is None else env
    argv = ["paths"] + (["--worker-dir", worker_dir] if worker_dir else []) + (["--agent", agent] if agent else [])
    a = ac.build_parser().parse_args(argv)
    wd = os.path.abspath(os.path.expanduser(a.worker_dir)) if a.worker_dir else ac.default_worker_dir(env)
    _dotenv, _agent, _src, wm, st = ac._resolve(a, "paths", wd, env)
    ac.check_settings(st)
    token = ac.read_token(st["token_file"])
    client = ac.HubClient(st["url"], token, False, st["cafile"], 60, agent_id=st["agent_id"] or None,
                          proxy=st["proxy"], no_proxy=st["no_proxy"], workspaces=wm.names(), runtime=st.get("runtime"),
                          role=st.get("role"), pull_every_seconds=st.get("pull_every_seconds"),
                          dsh_profile=st.get("dsh_profile"), can=st.get("can"))
    workspaces = {n: p for n, p in wm.workspaces.items() if n in wm.names()}
    return client, workspaces, st.get("role")


def main(argv=None):
    p = argparse.ArgumentParser(description="stdio MCP bridge from a coding agent to dsh-hub")
    p.add_argument("--agent", help="agent id (agents/<id>.json); default DSH_AGENT or the only agent")
    p.add_argument("--worker-dir", help="default <DSH home>/worker")
    p.add_argument("--no-patch", action="store_true", help="do not attach changes.patch on submit_result")
    p.add_argument("--keepalive-seconds", type=int, default=KEEPALIVE_SECONDS, help="lease renew period, 10..60")
    p.add_argument("--check", action="store_true", help="get a token and list the tools once, then exit")
    a = p.parse_args(argv)
    try:
        client, workspaces, role = load(a.agent, a.worker_dir)
    except (ac.ConfigError, OSError) as e:
        log(f"error: {e}")
        return 2
    hub = HubMcp(client)
    bridge = Bridge(client, hub, workspaces, role, sys.stdout.buffer, keepalive=max(10, min(60, a.keepalive_seconds)),
                    make_patch=not a.no_patch, can=client.can, tasklog=os.environ.get("DSH_BRIDGE_TASKLOG") or None)
    log(f"{client.agent_id} ({role}) -> {ac.mask_url(hub.root)}; workspaces: {', '.join(sorted(workspaces)) or '-'}")
    if a.check:
        try:
            hub.token()
            init = hub.post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                             "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "check", "version": "1"}}})
            tools = hub.post({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        except (BridgeError, OSError) as e:
            log(f"check failed: {e}")
            return 1
        names = [t["name"] for t in tools["result"]["tools"]]
        print(json.dumps({"ok": True, "agent_id": client.agent_id, "role": role, "server": init["result"]["serverInfo"],
                          "tools": names, "workspaces": sorted(workspaces)}, ensure_ascii=False))
        return 0
    bridge.serve(sys.stdin.buffer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
