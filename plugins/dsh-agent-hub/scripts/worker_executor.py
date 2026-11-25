#!/usr/bin/env python3
"""dsh-hub worker executor: consumes exchange/inbox/ and answers with result.json.

WHY THIS FILE EXISTS
--------------------
`agent_client.py run` is the transport half of a worker: it heartbeats, long-polls,
writes each leased task to `exchange/inbox/<task_id>/task.json`, reports progress
and uploads whatever appears in `exchange/outbox/<task_id>/` (or `failed/<task_id>/`)
once `result.json` is there. It never executes anything -- the exchange README calls
the consumer "the agent", and that consumer did not exist on the workstation. This script is
that consumer: the smallest thing that turns "a task landed in inbox/" into "a real
result came back to the hub".

It speaks the SAME local contract as the client (no new protocol, no hub change):

  inbox/<task_id>/task.json + input files   written by agent_client.py (never by us)
  working/<task_id>/                        we move the folder here while we run it
                                            (the client then reports progress "working"
                                            and keeps the lease alive every cycle)
  outbox/<task_id>/                         success: summary.md, stdout.txt, ... and
                                            result.json LAST
  failed/<task_id>/                         failure: result.json LAST (+ summary.md)
  archive/<task_id>/                        the client moves it there after upload

result.json is exactly what `Bridge.push()` reads (agent_client.py):

  {"status": "completed"|"failed"|"partial",   # partial -> the hub stores failed
   "summary": "text",                          # hub keeps 4000 chars
   "error": {"code": "...", "message": "...", "retryable": false},
   "needs_input": "..."}                       # optional

Every other file in the result folder is uploaded inline (base64) as an output;
names must match the hub's file-name rule, at most 50 files, and the hub refuses a
>20 MiB result body -- so this script keeps stdout/stderr and the summary small.

WHAT IT CAN EXECUTE (and what it refuses)
----------------------------------------
A task is planned from `task.context.executor` when the dispatcher sends a structured
directive, otherwise from the instruction text itself (see `parse_instruction`).
Supported actions:

  file    read one file the dispatcher names: size in bytes, sha256 (lower-case hex),
          line count, the requested line(s) verbatim, plus a short head excerpt.
          Read-only by construction.
  run     run one command in a fixed working directory; report exit code, stdout,
          stderr, duration. The command must come from an explicit marker (a fenced
          block, `命令:`/`cmd:`/`command:`/`run:` line) -- free-form prose is never
          turned into a command.
  script  write a short script (from a fenced code block) to a file inside the
          workspace and run it with python / pwsh; report exit code, stdout, stderr.

Any other request is answered with status=failed, error.code=UNSUPPORTED_TASK and
retryable=false -- never with a fake success. The whole point of this worker is that
a returned result is a real measurement.

SAFETY (all of it is enforced here, in code -- see the DENY list below)
-----------------------------------------------------------------------
* Working directory: every command runs in the task's `workspace_path` (or a `cwd`
  inside it); a `cwd`, script path or read path outside the allowed roots is refused.
  Allowed roots = the task workspace, the exchange folder (read only) and whatever
  `--allow-root` adds. Reads default to those roots too (`--read-any` lifts that).
* Timeout: every command/script has one (default 60 s, hard cap --max-timeout, 300 s).
  A timed-out process is killed and the task failed with EXEC_TIMEOUT.
* Output: stdout/stderr are truncated (head+tail, --max-output bytes) before they are
  put in the summary or written to result files.
* Environment: child processes get a small ALLOW-LIST environment (PATH, TEMP, ...),
  never the executor's own environment, so no DSH_* variable, proxy setting or token
  can reach a task. On top of that every captured byte is scrubbed for token-shaped
  strings (dsh[ac]_) before it is written anywhere.
* Credential files: reads of `agent.token`, `*.env`, ~/.ssh, ~/.claude, ... are refused
  outright, so a task cannot ask this worker to print its own token.
* Deny list: file deletion, service/container/firewall/user/registry changes, process
  killing, git history writes, download-and-execute, reading the process environment.
  A task that needs those is a human job, not a worker job.
* Honest limit: this is a deny list plus a working directory, NOT an OS sandbox. A
  script written by a malicious controller can still do harm; only controllers whose
  token the hub accepts can dispatch here, and `code`/`run` tasks should stay trusted.

HOW IT RUNS (see start-executor.ps1)
------------------------------------
A second resident process next to `agent_client.py run`, started through WMI as
pythonw.exe, one instance only (a byte-range lock on <worker>/executor.lock), all
output in <worker>/executor.log. Reasons for a separate process instead of an
execution loop inside agent_client.py:
  1. the running client (e.g. via worker_run.py) would have to be restarted to pick a change up --
     that is a needless offline window on a worker the hub must see online;
  2. a task that hangs or crashes the executor cannot take the heartbeat down with it;
  3. the executor can be stopped/restarted/upgraded alone, the worker stays online.

usage:
  python worker_executor.py                  # resident loop
  python worker_executor.py --once           # process everything pending, then exit
  python worker_executor.py --task <id>      # process one task id, then exit
  python worker_executor.py --once --root <exchange> --log <file>   # self-test
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time

PROTOCOL = "dsh-agent/2.0"
EXECUTOR_VERSION = "worker_executor/1.0.0"
BOXES = ("inbox", "working", "outbox", "failed", "archive")
TASK_ID_RE = re.compile(r"[A-Za-z0-9_.-]{1,96}")
# same rule the hub applies to output file names (agent_client.FILE_NAME_RE)
FILE_NAME_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _.()-]{0,127}")
ABORT_MARK = "ABORTED.json"          # written by the client when the hub aborts a task
START_MARK = ".executor-start.json"  # written by us before executing (double-run guard)
PROGRESS_FILE = "progress.jsonl"     # stages for the hub (agent_client.py sends them)
SESSION_FILE = "session.jsonl"       # the task's session log for the hub
SUMMARY_MAX = 3500                   # the hub truncates at 4000
DEFAULT_TIMEOUT = 60
MAX_TIMEOUT = 300
DEFAULT_OUTPUT_MAX = 6000            # per stream, head+tail
TOKEN_SHAPE = re.compile(r"\bdsh[ac]_[A-Za-z0-9_\-]{8,}")
SAFE_ENV_KEYS = ("PATH", "PATHEXT", "SystemRoot", "windir", "SystemDrive", "COMSPEC", "TEMP", "TMP",
                 "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
                 "PROCESSOR_ARCHITECTURE", "OS", "LANG")

# ---------------------------------------------------------------------------
# Deny list: (regex, why). Scanned against the command text and against a script
# body before anything is executed. Deliberately blunt: a refusal is always safe,
# a human can still do the operation by hand. Never executed as a shell pattern.
# ---------------------------------------------------------------------------
DENY = (
    (r"(?i)(?:^|[\s;&|])rm\s+-[a-z]*[rf]", "deletes files (rm -r/-f)"),
    (r"(?i)\b(?:del|erase)\s+(?:/[a-z]\s+)*[^\s]", "deletes files (del/erase)"),
    (r"(?i)\b(?:rmdir|Remove-Item|Move-Item|Clear-Content)\b", "deletes or overwrites files"),
    (r"(?i)\bformat(?:\.com)?\s+[a-z]:", "formats a volume"),
    (r"(?i)\b(?:mkfs|diskpart|bcdedit|fdisk)\b", "touches disks or the boot configuration"),
    (r"(?i)\b(?:shutdown|Restart-Computer|Stop-Computer)\b", "shuts down or reboots the machine"),
    (r"(?i)\b(?:Restart|Stop|Start|Set|New|Remove)-Service\b|\bsc(?:\.exe)?\s+(?:stop|start|delete|config)\b"
     r"|\bnet\s+(?:stop|start|user|localgroup|share)\b|systemctl\b", "changes a service, account or share"),
    (r"(?i)\b(?:docker|podman)(?:\.exe)?\s+\w", "touches containers"),
    (r"(?i)\breg(?:\.exe)?\s+(?:add|delete|import|load|restore)\b|\bSet-ExecutionPolicy\b"
     r"|\bSet-ItemProperty\b.*HKLM", "changes the registry or the execution policy"),
    (r"(?i)\bschtasks\b|\bRegister-ScheduledTask\b|\bUnregister-ScheduledTask\b|\bcrontab\b", "schedules a task"),
    (r"(?i)\b(?:takeown|icacls|cacls|attrib)\b", "changes file permissions"),
    (r"(?i)\b(?:netsh|New-NetFirewallRule|Set-NetFirewallRule|Remove-NetFirewallRule)\b",
     "changes the firewall or network configuration"),
    (r"(?i)\b(?:Stop-Process|taskkill|pkill)\b|(?:^|[\s;&|])kill\s", "stops a process"),
    (r"(?i)\bgit\s+(?:push|commit|reset|clean|checkout|switch|rebase|merge|tag|stash|gc|prune)\b",
     "writes git history or the working tree"),
    (r"(?i)\bInvoke-Expression\b|\biex\b|\|\s*(?:pwsh|powershell|cmd|bash|sh|python[0-9.]*)\b",
     "pipes text into an interpreter"),
    (r"(?i)\b(?:iwr|Invoke-WebRequest|curl|wget|Start-BitsTransfer)\b[^|]*\|\s*", "downloads and pipes"),
    (r"(?i)\$env:|\b(?:Get-ChildItem|gci|dir|ls)\s+env:|\bprintenv\b", "reads the process environment"),
    (r"(?i)agent\.token|dsh-local\.env|\.ssh[/\\]|id_rsa|id_ed25519|\.claude[/\\]|\.netrc|hub-ca\.pem",
     "would read a credential or key file"),
    (r"(?i)\b(?:safe-restart|safe-build-host|dsh\.exe|journalctl|cordis\.patch)\b", "touches DSH internals"),
)
# Files that may never be read by a task (they hold the worker/controller token).
SECRET_FILE_NAMES = ("agent.token", "dsh-local.env", "worker.env", ".env", "id_rsa", "id_ed25519",
                     "credentials", ".netrc", "agent.token.rejected")
SECRET_DIR_NAMES = (".ssh", ".claude", ".netrc", "secrets")
CODE_LANGS = {"python": "python", "py": "python", "python3": "python", "pwsh": "pwsh", "powershell": "pwsh",
              "ps1": "pwsh", "ps": "pwsh", "bat": "cmd", "cmd": "cmd", "sh": "sh", "bash": "sh"}


class Refused(Exception):
    """The task (or one of its steps) is not allowed to run. Becomes a failed result."""

    def __init__(self, code, message):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


# --- small helpers -----------------------------------------------------------

def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def now_local():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def scrub(text):
    """No token ever leaves this process, even if a task printed one."""
    return TOKEN_SHAPE.sub(lambda m: m.group(0)[:4] + "***[redacted]", str(text))


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def norm(path):
    """Absolute, case-folded on Windows, with forward slashes: for prefix checks."""
    p = os.path.abspath(os.path.expanduser(str(path)))
    p = os.path.realpath(p)
    return p.replace("\\", "/").rstrip("/").lower() if os.name == "nt" else p.replace("\\", "/").rstrip("/")


def inside(path, root):
    p, r = norm(path), norm(root)
    return p == r or p.startswith(r + "/")


def inside_any(path, roots):
    return any(inside(path, r) for r in roots)


def decode(data):
    """Command output -> text: utf-8 first, then the local code page, never a crash."""
    if not data:
        return ""
    for enc in ("utf-8", "gbk", "cp1252"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace")


def truncate(text, limit):
    text = scrub(text)
    if len(text) <= limit:
        return text
    head = limit * 2 // 3
    tail = limit - head
    return f"{text[:head]}\n... [{len(text) - limit} chars truncated] ...\n{text[-tail:]}"


def parse_env_text(text):
    """worker/.env -> dict, same rules as agent_client.parse_env_text (comments, export, quotes)."""
    out = {}
    for raw in (text or "").lstrip("\ufeff").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^export\s+", "", line)
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key or ""):
            continue
        if value[:1] in ("'", '"'):
            end = value.find(value[0], 1)
            if end < 0:
                continue
            value = value[1:end]
        elif value.startswith("#"):
            value = ""
        else:
            cut = re.search(r"\s#", value)
            if cut:
                value = value[:cut.start()].rstrip()
        out[key] = value
    return out


def default_worker_dir():
    home = os.environ.get("DSH_HOME")
    base = os.path.abspath(os.path.expanduser(home)) if home and home.strip() else os.path.abspath(os.path.expanduser("~/.dsh"))
    return os.path.join(base, "worker")


def safe_child_env():
    """Allow-list environment for child processes: no DSH_*, no proxies, no tokens."""
    env = {k: os.environ[k] for k in SAFE_ENV_KEYS if k in os.environ}
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env.setdefault("PATH", r"C:\Windows\System32;C:\Windows")
    return env


def shell_argv(command):
    """pwsh when present, else Windows PowerShell; always a fresh non-interactive run."""
    exe = shutil.which("pwsh") or shutil.which("powershell") or "powershell.exe"
    return [exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; " + command]


def python_exe():
    """The console interpreter: this executor runs under pythonw.exe (no console), and a
    task script that reads stdin or writes a lot should not inherit that. Prefer the
    python.exe next to it."""
    exe = sys.executable
    if os.name == "nt" and os.path.basename(exe).lower() == "pythonw.exe":
        candidate = os.path.join(os.path.dirname(exe), "python.exe")
        if os.path.isfile(candidate):
            return candidate
    return exe


def check_denied(text, what="command"):
    for pattern, why in DENY:
        if re.search(pattern, text or ""):
            raise Refused("COMMAND_DENIED", f"the {what} is refused: {why} (pattern {pattern!r}); "
                                            "a human has to do this by hand")


def read_task(task_dir):
    path = os.path.join(task_dir, "task.json")
    with open(path, encoding="utf-8-sig") as f:
        task = json.load(f)
    if not isinstance(task, dict) or not isinstance(task.get("task_id"), str):
        raise Refused("BAD_TASK", "task.json has no task_id")
    return task


# --- instruction parsing -----------------------------------------------------

FENCE_RE = re.compile(r"```([A-Za-z0-9_+-]*)[ \t]*\r?\n(.*?)```", re.S)
WIN_PATH_RE = re.compile(r"[A-Za-z]:[\\/][^\s\"'`<>|*?，。；：、）】\]]+")
FILE_EXT = r"(?:js|mjs|cjs|py|ps1|json|md|txt|yml|yaml|ts|tsx|jsx|html|css|sh|bat|cmd|env|pem|log|toml|ini|xml|java|go|rs|sql)"
REL_PATH_RE = re.compile(r"(?:[\w.\-]+[\\/])+[\w.\-]+\." + FILE_EXT)
# a bare file name ("data.txt", "agent_client.py") when the instruction does not spell a folder
BARE_NAME_RE = re.compile(r"(?<![\w./\\-])[\w.\-]+\." + FILE_EXT + r"(?![\w])")
LINE_WORDS = ("行", "line")
LINE_HINT_RE = re.compile(r"(?i)第\s*\d+\s*行|\blines?\s*\d+|\bL\d+\b")
READ_WORDS = ("读", "read", "查看", "看看", "检查", "打印", "cat ", "内容", "列出", "list")
HASH_WORDS = ("sha256", "sha-256", "哈希", "hash", "摘要", "校验")
SIZE_WORDS = ("大小", "字节", "size", "bytes", "byte")
SCRIPT_WORDS = ("脚本", "script", "程序", "program")
CMD_MARK_RE = re.compile(r"(?im)^[ \t>*-]*(?:命令|cmd|command|run|execute)\s*[:：]\s*(\S.*)$")


def clean_path_token(value):
    """Strip quotes, Markdown and trailing punctuation from a path found in prose."""
    token = str(value).strip().strip("`'\"<>[]()*")
    token = re.sub(r"[，。；：、）】,;:]+$", "", token)
    return token.strip()


def file_like(token):
    """'README.md' yes; a folder such as 'C:\\path\\to\\repo' no.

    An instruction usually names both ("workspace root is <dir>, read <file>"), and
    the file is what a read request means.
    """
    name = os.path.basename(str(token).replace("\\", "/").rstrip("/"))
    return re.fullmatch(r"[^\\/]+\.[A-Za-z0-9]{1,8}", name) is not None


def extract_paths(text):
    """Paths named in prose, in priority order and without sub-matches.

    A Windows path also matches the looser rules ('C:\\a\\b.py' contains 'a\\b.py'),
    so a match that lies inside an earlier match is dropped: the first (most
    specific) hit wins, and the last hit is the one the author wrote last.
    """
    text = text or ""
    spans, found = [], []
    for regex in (WIN_PATH_RE, REL_PATH_RE, BARE_NAME_RE):
        for m in regex.finditer(text):
            start, end = m.span()
            if any(start >= a and end <= b for a, b in spans):
                continue
            token = clean_path_token(m.group(0))
            if not token:
                continue
            spans.append((start, end))
            if token not in found:
                found.append(token)
    return found


def extract_lines(text):
    """'第 352 行' / 'line 352' / '第 10-12 行' / 'lines 10 to 12' -> [n, ...] (ranges expanded, capped)."""
    nums, ranges = [], []
    for pattern in (r"第\s*(\d+)\s*[-–~到]\s*(\d+)\s*行", r"(?i)lines?\s*(\d+)\s*[-–~to]+\s*(\d+)"):
        ranges.extend((int(a), int(b)) for a, b in re.findall(pattern, text or ""))
    for pattern in (r"第\s*(\d+)\s*行", r"(?i)\bline\s*(\d+)\b", r"(?i)\bL(\d+)\b(?!\w)"):
        nums.extend(int(n) for n in re.findall(pattern, text or ""))
    out = []
    for a, b in ranges:
        lo, hi = (a, b) if a <= b else (b, a)
        out.extend(range(lo, min(hi, lo + 20) + 1))
    for n in nums:
        if n not in out:
            out.append(n)
    return sorted(set(out))[:10]


def find_fence(text):
    m = FENCE_RE.search(text or "")
    if not m:
        return None
    lang = (m.group(1) or "").strip().lower()
    body = m.group(2)
    if not body.strip():
        return None
    return lang, body.rstrip("\n")


def guess_lang(code):
    if re.search(r"(?m)^\s*(?:import |from \w+ import |def |print\()", code):
        return "python"
    if re.search(r"(?im)^\s*(?:\$|Write-Host|Get-|Set-|\$env|param\()", code):
        return "pwsh"
    return "python"


def parse_instruction(task):
    """Plan a task from its instruction alone. Returns (spec, note) or (None, reason)."""
    text = str(task.get("instruction") or "")
    both = str(task.get("title") or "") + "\n" + text
    lower = both.lower()
    wants_script = any(w in lower for w in SCRIPT_WORDS)
    wants_run = any(w in lower for w in ("运行", "执行", "跑", "run", "execute", "invoke"))
    wants_read = (any(w in lower for w in READ_WORDS + HASH_WORDS + SIZE_WORDS)
                  or bool(LINE_HINT_RE.search(both)))
    fence = find_fence(text)

    # 1) a code block that is meant to be written to a file and run
    if fence is not None:
        lang, code = fence
        if wants_script or (lang in CODE_LANGS and lang not in ("cmd", "bat", "sh", "bash") and not wants_run):
            return {"action": "script", "language": CODE_LANGS.get(lang) or guess_lang(code), "code": code,
                    "filename": extract_script_name(both), "cwd": None, "timeout_s": None}, \
                   f"instruction:script(fence lang={lang or '?'})"
        if wants_run:
            # a fenced block that the instruction asks to *run* is a command, not a file
            return {"action": "run", "cmd": code if lang not in CODE_LANGS or lang in ("cmd", "bat", "sh", "bash")
                    else None, "script": None if lang not in CODE_LANGS or lang in ("cmd", "bat", "sh", "bash") else code,
                    "language": CODE_LANGS.get(lang) or "pwsh", "cwd": None, "timeout_s": None}, \
                   f"instruction:run(fence lang={lang or '?'})"

    # 2) an explicit command marker ("命令: ...", "cmd: ...", "run: ...")
    m = CMD_MARK_RE.search(text)
    if m and m.group(1).strip():
        return {"action": "run", "cmd": m.group(1).strip().strip("`"), "cwd": None, "timeout_s": None}, \
               "instruction:run(marker)"

    # 3) read a named file and report size / sha256 / lines
    paths = extract_paths(text)
    if paths and wants_read:
        paths = sorted(paths, key=lambda p: 0 if file_like(p) else 1)  # a file beats the workspace root
        return {"action": "file", "path": paths[0], "lines": extract_lines(both), "excerpt_lines": 8}, \
               "instruction:file"

    return None, "instruction:none"


def extract_script_name(text):
    """A file name the instruction wants the script written to (last one wins)."""
    for token in reversed(extract_paths(text)):
        if re.search(r"\.(?:py|ps1|sh|bat|cmd)$", token, re.I):
            return token
    return None


def normalize_spec(spec):
    """A directive from task.context.executor -> a plan dict (unknown action -> None)."""
    action = str(spec.get("action") or "").strip().lower()
    if action not in ("file", "run", "script"):
        return None
    out = dict(spec)
    out["action"] = action
    if action == "file":
        out["path"] = spec.get("path")
        out["lines"] = [int(n) for n in spec.get("lines") or [] if str(n).isdigit()]
    return out


# --- the executor ------------------------------------------------------------

class Executor:
    def __init__(self, root, log, extra_roots=(), read_any=False, default_timeout=DEFAULT_TIMEOUT,
                 max_timeout=MAX_TIMEOUT, output_max=DEFAULT_OUTPUT_MAX, adopt=False):
        self.root = os.path.abspath(root)
        self.log = log
        self.extra_roots = [os.path.abspath(p) for p in extra_roots]
        self.read_any = read_any
        self.default_timeout = max(5, min(int(default_timeout), MAX_TIMEOUT))
        self.max_timeout = max(self.default_timeout, min(int(max_timeout), MAX_TIMEOUT))
        self.output_max = max(200, int(output_max))
        self.adopt = adopt

    # --- folders ---------------------------------------------------------
    def ensure_boxes(self):
        for box in BOXES:
            os.makedirs(os.path.join(self.root, box), exist_ok=True)

    def boxes(self, box):
        return os.path.join(self.root, box)

    def pending(self):
        base = self.boxes("inbox")
        try:
            names = os.listdir(base)
        except FileNotFoundError:
            return []
        out = []
        for name in sorted(names):
            d = os.path.join(base, name)
            if name.startswith(".") or not TASK_ID_RE.fullmatch(name) or not os.path.isdir(d):
                continue
            if not os.path.isfile(os.path.join(d, "task.json")):
                continue  # the client is still staging it (.<id>.part)
            out.append(name)
        return out

    def claim(self, task_id):
        """Move inbox/<id> -> working/<id>. False when it is gone or already taken."""
        src = os.path.join(self.boxes("inbox"), task_id)
        dst = os.path.join(self.boxes("working"), task_id)
        if os.path.exists(dst):
            return False
        try:
            os.replace(src, dst)
            return True
        except OSError:
            return False

    def aborted(self, task_id):
        for box in ("inbox", "working", "outbox"):
            if os.path.exists(os.path.join(self.boxes(box), task_id, ABORT_MARK)):
                return True
        return False

    def done(self, task_id):
        return any(os.path.exists(os.path.join(self.boxes(box), task_id))
                   for box in ("outbox", "failed", "archive"))

    # --- one task ---------------------------------------------------------
    def handle(self, task_id):
        started = time.time()
        work = os.path.join(self.boxes("working"), task_id)
        try:
            task = read_task(work)
        except Exception as exc:  # noqa: BLE001 -- a broken task.json must not kill the loop
            self.log(f"ERROR {task_id}: task.json unreadable ({type(exc).__name__}: {exc})")
            self.finish_failed(task_id, "BAD_TASK", f"task.json unreadable: {exc}", started)
            return
        write_atomic(os.path.join(work, START_MARK), json.dumps(
            {"executor": EXECUTOR_VERSION, "pid": os.getpid(), "started_at": now_iso(),
             "started_local": now_local()}, ensure_ascii=False, indent=2))
        self.log(f"claimed {task_id}: type={task.get('type')} ws={task.get('workspace')} "
                 f"title={json.dumps(task.get('title'), ensure_ascii=False)}")
        self.trail(task_id, progress={"stage": "started", "message": "executor started"},
                   session=[{"role": "user", "text": str(task.get("instruction") or task.get("title") or "")}])
        try:
            spec, note = self.plan(task)
            self.log(f"plan {task_id}: {note} -> {json.dumps(spec, ensure_ascii=False)[:300]}")
            self.trail(task_id, progress={"stage": "step", "message": f"running {spec.get('action')}"},
                       session=[{"role": "note", "text": f"plan ({note}): {json.dumps(spec, ensure_ascii=False)[:2000]}"}])
            outcome = self.execute(task, spec)
            self.finish(task_id, outcome, started)
        except Refused as exc:
            self.log(f"refused {task_id}: {exc.code}: {exc.message}")
            self.finish_failed(task_id, exc.code, exc.message, started)
        except Exception as exc:  # noqa: BLE001 -- never leave a task hanging
            self.log(f"ERROR {task_id}: {type(exc).__name__}: {exc}")
            self.finish_failed(task_id, "EXECUTOR_ERROR", f"{type(exc).__name__}: {exc}", started)

    def plan(self, task):
        ctx = task.get("context")
        spec, note = None, "instruction:none"
        if isinstance(ctx, dict) and isinstance(ctx.get("executor"), dict):
            spec = normalize_spec(ctx["executor"])
            note = "context.executor" if spec is not None else "context.executor:unknown-action"
        else:
            spec, note = parse_instruction(task)
        if spec is None:
            raise Refused("UNSUPPORTED_TASK",
                          "this executor only runs file/run/script tasks and could not find one in the "
                          "instruction (no fenced code block, no explicit command marker, no file+sha256/line "
                          "request). Send context.executor with {action: file|run|script,...} for a structured "
                          f"task (plan: {note}).")
        return spec, note

    # --- allowed roots ----------------------------------------------------
    def roots_for(self, task):
        roots = []
        ws = task.get("workspace_path")
        if isinstance(ws, str) and ws.strip():
            roots.append(ws)
        roots.extend(self.extra_roots)
        return roots

    def require_inside(self, path, roots, what):
        if not inside_any(path, roots):
            raise Refused("PATH_OUTSIDE_WORKSPACE",
                          f"{what} {path!r} is outside the allowed roots ({', '.join(roots) or 'none'})")
        # never write into the exchange folder: that is the client's mailbox
        if inside(path, self.root):
            raise Refused("PATH_IN_EXCHANGE", f"{what} {path!r} is inside the exchange folder; refused")
        return os.path.abspath(os.path.expanduser(path))

    def require_readable(self, path, roots):
        name = os.path.basename(path).lower()
        parts = [p.lower() for p in os.path.abspath(path).replace("\\", "/").split("/")]
        if name in SECRET_FILE_NAMES or name.startswith("agent.token") or name.endswith(".env"):
            raise Refused("SECRET_FILE", f"{os.path.basename(path)!r} is a credential file; a task may not read it")
        if any(p in SECRET_DIR_NAMES for p in parts):
            raise Refused("SECRET_FILE", f"{path!r} is inside a credential folder; a task may not read it")
        if not self.read_any and not inside_any(path, roots):
            raise Refused("PATH_OUTSIDE_WORKSPACE",
                          f"read path {path!r} is outside the allowed roots ({', '.join(roots) or 'none'}); "
                          "run with --read-any to lift this")
        if os.path.isdir(path):
            raise Refused("IS_DIRECTORY", f"{path!r} is a folder, not a file; name the file to read")
        if not os.path.isfile(path):
            raise Refused("FILE_NOT_FOUND", f"no such file: {path}")
        return os.path.abspath(path)

    # --- actions ----------------------------------------------------------
    def execute(self, task, spec):
        action = spec["action"]
        if action == "file":
            return self.action_file(task, spec)
        if action == "run":
            return self.action_run(task, spec)
        if action == "script":
            return self.action_script(task, spec)
        raise Refused("UNSUPPORTED_TASK", f"action {action!r} is not supported")

    def action_file(self, task, spec):
        roots = self.roots_for(task)
        raw = spec.get("path")
        if not isinstance(raw, str) or not raw.strip():
            raise Refused("BAD_DIRECTIVE", "file action needs a path")
        path = raw.strip()
        if not os.path.isabs(path):
            ws = task.get("workspace_path")
            if not isinstance(ws, str) or not ws.strip():
                raise Refused("BAD_DIRECTIVE", f"relative path {path!r} but the task has no workspace_path")
            path = os.path.join(ws, path)
        path = self.require_readable(path, roots)
        with open(path, "rb") as f:
            data = f.read()
        size = len(data)
        digest = hashlib.sha256(data).hexdigest()
        text = decode(data)
        lines = text.splitlines()
        wanted = [int(n) for n in (spec.get("lines") or []) if 1 <= int(n) <= max(len(lines), 1)]
        excerpt_n = int(spec.get("excerpt_lines") or 0)
        parts = [f"path: {path}", f"size_bytes: {size}", f"lines: {len(lines)}", f"sha256: {digest}"]
        for n in wanted:
            content = lines[n - 1] if n - 1 < len(lines) else ""
            parts.append(f"line{n}: {truncate(content, 1200)}")
        if excerpt_n and not wanted:
            parts.append("excerpt:")
            for i, line in enumerate(lines[:excerpt_n], 1):
                parts.append(f"{i:>4}| {truncate(line, 300)}")
        summary = "\n".join(parts)
        files = {"summary.md": summary + "\n"}
        result = {"status": "completed", "summary": truncate(summary, SUMMARY_MAX), "meta": {
            "action": "file", "path": path, "size_bytes": size, "sha256": digest, "lines": len(lines)}}
        return result, files

    def action_run(self, task, spec):
        roots = self.roots_for(task)
        cwd = self.command_cwd(task, spec, roots)
        timeout = self.timeout_of(spec)
        command = spec.get("cmd")
        if command is None and spec.get("script"):
            command = spec["script"]  # a fenced block the instruction asked to run
        if not isinstance(command, str) or not command.strip():
            raise Refused("BAD_DIRECTIVE", "run action needs a command string")
        check_denied(command, "command")
        return self.run_process(task, command, cwd, timeout, action="run", extra_files={})

    def action_script(self, task, spec):
        roots = self.roots_for(task)
        code = spec.get("code")
        if not isinstance(code, str) or not code.strip():
            raise Refused("BAD_DIRECTIVE", "script action needs code")
        language = str(spec.get("language") or "python").lower()
        language = CODE_LANGS.get(language, language if language in ("python", "pwsh", "cmd", "sh") else "python")
        check_denied(code, "script body")
        ws = task.get("workspace_path") if isinstance(task.get("workspace_path"), str) else ""
        raw_name = clean_path_token(spec.get("filename") or "")
        target = spec.get("path")
        if isinstance(target, str) and target.strip():
            target = clean_path_token(target)
        elif raw_name and (os.path.isabs(raw_name) or re.search(r"[\\/]", raw_name)):
            # the instruction named a path ("out/probe.py", "C:\...\p.py"): honour it, and
            # let require_inside refuse it when it points outside the workspace
            target = raw_name if os.path.isabs(raw_name) else os.path.join(ws, raw_name)
        else:
            name = os.path.basename(raw_name) if raw_name else ""
            if not re.fullmatch(r"[\w.\-]{1,64}\.(?:py|ps1|sh|bat|cmd)", name or "", re.I):
                name = "task_script.py" if language == "python" else "task_script.ps1"
            base = (spec.get("cwd") or ws or "").strip()
            if not base:
                raise Refused("BAD_DIRECTIVE", "script action needs a workspace or a path")
            target = os.path.join(base, ".dsh-executor", str(task["task_id"]), name)
        target = self.require_inside(target, roots, "script path")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8", newline="\n") as f:
            f.write(code if code.endswith("\n") else code + "\n")
        cwd = self.command_cwd(task, spec, roots)
        timeout = self.timeout_of(spec)
        args = [str(a) for a in (spec.get("args") or [])]
        if language == "python":
            interp = python_exe()
            argv = [interp, "-X", "utf8", target] + args
            shown = " ".join([os.path.basename(interp), os.path.basename(target)] + args)
        elif language == "pwsh":
            argv = shell_argv(f"& '{target}'") + args if args else [shutil.which("pwsh") or "powershell.exe",
                                                                   "-NoProfile", "-NonInteractive",
                                                                   "-ExecutionPolicy", "Bypass", "-File", target]
            shown = f"pwsh -File {os.path.basename(target)} {' '.join(args)}".strip()
        elif language == "cmd":
            argv = ["cmd.exe", "/d", "/c", target] + args
            shown = f"cmd /c {os.path.basename(target)}"
        else:
            raise Refused("UNSUPPORTED_TASK", f"language {language!r} is not supported")
        return self.run_process(task, argv, cwd, timeout, action="script", shown=shown,
                                extra_files={"script" + os.path.splitext(target)[1]: code})

    def command_cwd(self, task, spec, roots):
        cwd = spec.get("cwd")
        ws = task.get("workspace_path")
        if isinstance(cwd, str) and cwd.strip():
            if not os.path.isabs(cwd) and isinstance(ws, str) and ws.strip():
                cwd = os.path.join(ws, cwd)
        else:
            cwd = ws
        if not isinstance(cwd, str) or not cwd.strip():
            raise Refused("BAD_DIRECTIVE", "no working directory: the task has no workspace_path and no cwd")
        if not inside_any(cwd, roots):
            raise Refused("PATH_OUTSIDE_WORKSPACE",
                          f"cwd {cwd!r} is outside the allowed roots ({', '.join(roots) or 'none'})")
        cwd = os.path.abspath(cwd)
        if not os.path.isdir(cwd):
            raise Refused("CWD_MISSING", f"cwd does not exist: {cwd}")
        return cwd

    def timeout_of(self, spec):
        raw = spec.get("timeout_s")
        try:
            value = int(raw) if raw is not None else self.default_timeout
        except (TypeError, ValueError):
            value = self.default_timeout
        return max(5, min(value, self.max_timeout))

    def run_process(self, task, argv, cwd, timeout, action, shown=None, extra_files=None):
        command_text = argv if isinstance(argv, list) else shell_argv(argv)
        shown = shown or (command_text if isinstance(argv, list) else argv)
        env = safe_child_env()
        started = time.time()
        self.log(f"exec {task['task_id']}: {truncate(str(shown), 300)} (cwd={cwd}, timeout={timeout}s)")
        timed_out = False
        try:
            proc = subprocess.run(command_text, cwd=cwd, env=env, capture_output=True, timeout=timeout,
                                  creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0)
            stdout, stderr, code = decode(proc.stdout), decode(proc.stderr), proc.returncode
        except subprocess.TimeoutExpired as exc:
            timed_out = True
            stdout, stderr, code = decode(exc.stdout or b""), decode(exc.stderr or b""), None
        except OSError as exc:
            raise Refused("EXEC_FAILED", f"could not start the command: {exc}") from None
        elapsed = round(time.time() - started, 3)
        self.log(f"exec {task['task_id']}: exit={code} {elapsed}s timed_out={timed_out} "
                 f"stdout={len(stdout)}B stderr={len(stderr)}B")
        summary_lines = [f"action: {action}", f"cwd: {cwd}", f"command: {truncate(str(shown), 500)}",
                         f"exit_code: {'timeout' if timed_out else code}", f"duration_s: {elapsed}"]
        if stdout.strip():
            summary_lines += ["", "stdout:", truncate(stdout.strip(), 2000)]
        if stderr.strip():
            summary_lines += ["", "stderr:", truncate(stderr.strip(), 1200)]
        summary = "\n".join(summary_lines)
        files = {"summary.md": summary + "\n"}
        if stdout.strip():
            files["stdout.txt"] = truncate(stdout, self.output_max) + "\n"
        if stderr.strip():
            files["stderr.txt"] = truncate(stderr, self.output_max) + "\n"
        for name, text in (extra_files or {}).items():
            if not FILE_NAME_RE.fullmatch(name):
                continue
            files[name] = truncate(text, min(self.output_max, 20000))
        if timed_out:
            result = {"status": "failed", "summary": truncate(summary, SUMMARY_MAX),
                      "error": {"code": "EXEC_TIMEOUT", "message": f"the command did not finish in {timeout}s and was killed",
                                "retryable": False}}
            return result, files
        status = "completed" if code == 0 else "failed"
        result = {"status": status, "summary": truncate(summary, SUMMARY_MAX)}
        if status == "failed":
            result["error"] = {"code": "EXIT_CODE", "message": f"the command exited with {code}",
                               "retryable": False}
        result["meta"] = {"action": action, "cwd": cwd, "exit_code": code, "duration_s": elapsed}
        return result, files

    # --- progress.jsonl / session.jsonl (agent_client.py sends them to the hub) -----
    def trail(self, task_id, progress=None, session=()):
        """Append a progress line and session entries to working/<id>/. Best effort."""
        work = os.path.join(self.boxes("working"), task_id)
        if not os.path.isdir(work):
            return
        try:
            if progress:
                with open(os.path.join(work, PROGRESS_FILE), "a", encoding="utf-8", newline="\n") as f:
                    f.write(json.dumps(dict(progress, at=now_iso()), ensure_ascii=False) + "\n")
            if session:
                with open(os.path.join(work, SESSION_FILE), "a", encoding="utf-8", newline="\n") as f:
                    for e in session:
                        f.write(json.dumps(dict(e, text=scrub(e.get("text", "")), at=now_iso()), ensure_ascii=False) + "\n")
        except OSError as exc:
            self.log(f"{task_id}: could not write progress / session ({exc})")

    # --- results ----------------------------------------------------------
    def result_dir(self, task_id, ok):
        return os.path.join(self.boxes("outbox" if ok else "failed"), task_id)

    def write_result(self, task_id, result, files, started):
        ok = result.get("status") == "completed"
        dest = self.result_dir(task_id, ok)
        if os.path.exists(dest):
            shutil.rmtree(dest, ignore_errors=True)
        os.makedirs(dest, exist_ok=True)
        for name, text in (files or {}).items():
            if name == "summary.md":
                continue
            if not FILE_NAME_RE.fullmatch(name):
                self.log(f"{task_id}: output file name {name!r} is not accepted by the hub; skipped")
                continue
            write_atomic(os.path.join(dest, name), text)
        work = os.path.join(self.boxes("working"), task_id)
        for name in (PROGRESS_FILE, SESSION_FILE):  # the client sends what is left of them before the result
            if os.path.isfile(os.path.join(work, name)):
                shutil.copyfile(os.path.join(work, name), os.path.join(dest, name))
        if "summary.md" not in (files or {}):
            write_atomic(os.path.join(dest, "summary.md"), result.get("summary", "") + "\n")
        else:
            write_atomic(os.path.join(dest, "summary.md"), files["summary.md"])
        body = {"status": result.get("status"), "summary": result.get("summary", "")}
        if result.get("error"):
            body["error"] = result["error"]
        if result.get("needs_input"):
            body["needs_input"] = result["needs_input"]
        body["executor"] = {"version": EXECUTOR_VERSION, "action": (result.get("meta") or {}).get("action"),
                            "duration_s": round(time.time() - started, 3), "finished_at": now_iso()}
        write_atomic(os.path.join(dest, "result.json"), json.dumps(body, ensure_ascii=False, indent=2) + "\n")
        return dest

    def finish(self, task_id, outcome, started):
        result, files = outcome
        meta = result.get("meta") or {}
        self.trail(task_id, progress={"stage": "uploading", "message": f"{result.get('status')}"},
                   session=[{"role": "tool", "name": str(meta.get("action") or "executor"),
                             "text": (files or {}).get("summary.md") or result.get("summary", ""),
                             **({"error": True} if result.get("status") != "completed" else {})},
                            {"role": "assistant", "text": f"{result.get('status')}: "
                             + (result.get("error") or {}).get("message", "done") if result.get("error") else f"{result.get('status')}"}])
        dest = self.write_result(task_id, result, files, started)
        self.drop_working(task_id)
        self.log(f"done {task_id}: status={result.get('status')} in {time.time() - started:.2f}s -> {dest}")

    def finish_failed(self, task_id, code, message, started):
        result = {"status": "failed", "summary": f"failed: {code}: {message}",
                  "error": {"code": code, "message": truncate(message, 1800), "retryable": False}}
        self.trail(task_id, progress={"stage": "uploading", "message": f"failed: {code}"},
                   session=[{"role": "assistant", "text": result["summary"], "error": True}])
        dest = self.write_result(task_id, result, {"summary.md": result["summary"] + "\n"}, started)
        self.drop_working(task_id)
        self.log(f"done {task_id}: status=failed code={code} in {time.time() - started:.2f}s -> {dest}")

    def drop_working(self, task_id):
        work = os.path.join(self.boxes("working"), task_id)
        if os.path.isdir(work):
            shutil.rmtree(work, ignore_errors=True)

    # --- startup ----------------------------------------------------------
    def adopt_or_fail_stale(self):
        """A task left in working/ (executor died mid-run) must not hang forever.

        Default: answer failed/EXECUTOR_INTERRUPTED (retryable=false) -- re-running a
        command whose side effects are unknown is worse than an honest failure.
        --adopt re-runs it instead (a dispatcher who knows the task is idempotent).
        """
        base = self.boxes("working")
        try:
            names = os.listdir(base)
        except FileNotFoundError:
            return 0
        count = 0
        for name in sorted(names):
            d = os.path.join(base, name)
            if name.startswith(".") or not os.path.isdir(d) or self.done(name) or self.aborted(name):
                continue
            if self.adopt:
                self.log(f"adopting stale task {name} (--adopt): re-running it")
                continue
            self.log(f"stale task {name}: the executor stopped before it finished; answering EXECUTOR_INTERRUPTED")
            self.finish_failed(name, "EXECUTOR_INTERRUPTED",
                               "the executor process stopped while this task was running; "
                               "dispatch it again if the work is still needed", time.time())
            count += 1
        return count

    def tick(self):
        processed = 0
        for task_id in self.pending():
            if self.done(task_id) or self.aborted(task_id):
                continue
            if not self.claim(task_id):
                continue
            self.handle(task_id)
            processed += 1
        return processed


# --- single instance + resident loop ----------------------------------------

class InstanceLock:
    """One executor per worker folder: a byte-range lock the OS releases on crash."""

    def __init__(self, path):
        self.path = path
        self.fh = None

    def acquire(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.fh = open(self.path, "a+")
        try:
            import msvcrt
            self.fh.seek(0)
            msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
        except ImportError:  # POSIX self-test: fall back to a pid file check
            pid = self._read_pid()
            if pid and pid != os.getpid() and _alive(pid):
                return False
        except OSError:
            return False
        self.fh.seek(0)
        self.fh.truncate()
        self.fh.write(f"{os.getpid()} {now_iso()}\n")
        self.fh.flush()
        return True

    def _read_pid(self):
        try:
            return int((self.fh.read() or "").split()[0])
        except (ValueError, IndexError):
            return None

    def release(self):
        if self.fh is None:
            return
        try:
            import msvcrt
            self.fh.seek(0)
            msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
        except Exception:  # noqa: BLE001 -- best effort on the way out
            pass
        self.fh.close()
        self.fh = None


def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class Logger:
    def __init__(self, path):
        self.path = path
        self.fh = None
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            self.fh = open(path, "a", encoding="utf-8", buffering=1)

    def __call__(self, message):
        line = f"{now_iso()} {now_local()} {scrub(message)}"
        if self.fh:
            self.fh.write(line + "\n")
        try:
            if sys.stderr is not None:
                print(line, file=sys.stderr, flush=True)
        except Exception:  # noqa: BLE001 -- pythonw may not have a console
            pass


def resolve_root(args, worker_dir):
    """Exchange folder, log file and lock file of this executor.

    --root names the folder outright (log / lock then default to the worker folder). Otherwise
    the agent is picked exactly as `agent_client.py run` picks it (--agent, DSH_AGENT, or the only
    agents/<id>.json) and its own files are used: exchange/<agent>/, logs/<agent>.executor.log and
    a lock inside the exchange folder -- so the executor always reads the inbox the client writes."""
    if args.root:
        return {"exchange": os.path.abspath(os.path.expanduser(args.root)), "agent": args.agent,
                "executor_log": os.path.join(worker_dir, "executor.log"),
                "executor_lock": os.path.join(worker_dir, "executor.lock")}
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import agent_client  # same folder; reads worker/.env and agents/<id>.json the same way
    return agent_client.resolve_files(worker_dir, args.agent)


def main(argv=None):
    p = argparse.ArgumentParser(description=f"dsh-hub worker executor ({EXECUTOR_VERSION}, {PROTOCOL})")
    p.add_argument("--worker-dir", default=None, help="worker folder (default <DSH home>/worker)")
    p.add_argument("--agent", default=None, help="which agents/<id>.json (default: DSH_AGENT, or the only one)")
    p.add_argument("--root", default=None, help="exchange folder (default: the agent's own, as agent_client.py paths prints)")
    p.add_argument("--log", default=None, help="log file (default <worker>/logs/<agent>.executor.log)")
    p.add_argument("--interval", type=float, default=1.5, help="seconds between scans in the resident loop")
    p.add_argument("--once", action="store_true", help="process what is pending, then exit")
    p.add_argument("--task", default=None, help="process one task id, then exit")
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="default command timeout (s)")
    p.add_argument("--max-timeout", type=int, default=MAX_TIMEOUT, help="hard timeout cap (s)")
    p.add_argument("--max-output", type=int, default=DEFAULT_OUTPUT_MAX, help="bytes kept per stream")
    p.add_argument("--allow-root", action="append", default=[], help="extra allowed root (repeatable)")
    p.add_argument("--read-any", action="store_true", help="allow file reads outside the allowed roots")
    p.add_argument("--adopt", action="store_true", help="re-run tasks left in working/ instead of failing them")
    p.add_argument("--no-lock", action="store_true", help="do not take the single-instance lock (self-test)")
    a = p.parse_args(argv)

    worker_dir = os.path.abspath(os.path.expanduser(a.worker_dir)) if a.worker_dir else default_worker_dir()
    try:
        files = resolve_root(a, worker_dir)
    except Exception as exc:  # noqa: BLE001 -- ConfigError from agent_client: say why and stop
        Logger(a.log or os.path.join(worker_dir, "executor.log"))(f"{EXECUTOR_VERSION}: cannot read the worker settings: {exc}")
        return 2
    root = files["exchange"]
    log = Logger(a.log or files["executor_log"])
    lock = None
    if not a.no_lock:
        lock = InstanceLock(files["executor_lock"])
        if not lock.acquire():
            log(f"{EXECUTOR_VERSION}: another executor already holds {lock.path}; this one exits")
            return 0
    ex = Executor(root, log, extra_roots=a.allow_root, read_any=a.read_any, default_timeout=a.timeout,
                  max_timeout=a.max_timeout, output_max=a.max_output, adopt=a.adopt)
    ex.ensure_boxes()
    log(f"{EXECUTOR_VERSION} start pid={os.getpid()} root={root} interval={a.interval}s "
        f"timeout={ex.default_timeout}s/{ex.max_timeout}s python={sys.executable}")
    try:
        if a.task:
            task_id = a.task
            if not os.path.isdir(os.path.join(ex.boxes("inbox"), task_id)) and not os.path.isdir(os.path.join(ex.boxes("working"), task_id)):
                log(f"task {task_id} is neither in inbox/ nor in working/; nothing to do")
                return 2
            if not os.path.isdir(os.path.join(ex.boxes("working"), task_id)):
                ex.claim(task_id)
            ex.handle(task_id)
            return 0
        ex.adopt_or_fail_stale()
        if a.once:
            log(f"once: processed {ex.tick()} task(s)")
            return 0
        log("resident: watching inbox/ -- Ctrl+C or kill to stop (the worker stays online in agent_client.py run)")
        while True:
            try:
                ex.tick()
            except Exception as exc:  # noqa: BLE001 -- the loop must survive one bad task
                log(f"ERROR loop: {type(exc).__name__}: {exc}")
            time.sleep(max(0.2, a.interval))
    except KeyboardInterrupt:
        log("stopped by Ctrl+C; the client keeps this worker online")
        return 0
    finally:
        if lock:
            lock.release()


if __name__ == "__main__":
    sys.exit(main())
