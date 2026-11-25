#!/usr/bin/env python3
"""dsh-hub worker client: the worker end of dsh-agent/2.0 (stdlib only).

Contract: docs/DSH-HUB-PROTOCOL-v2.md (registration and presence: section 9). The
hub is a standalone service on port 7891 (prefix /v1). Every request carries the
worker id in the query (`?id=<agent id>`); the token goes in the `X-DSH-Token`
header, never the query. On MYDESK the hub traffic leaves through the local
Clash/mihomo HTTP proxy (DSH_HUB_PROXY=http://127.0.0.1:7890): 7890 is that proxy,
not the hub. The server only accepts traffic from outside, so the proxy rule for
the hub must use a proxy node, and the hub sees that node's exit IP.

Lifecycle of a worker (one per machine folder <DSH home>/worker):

  init       write .env and profile.json templates into the worker dir (existing files
             are never overwritten), create the exchange folder (DSH_EXCHANGE: inbox, working,
             outbox, failed, archive + README.md; --no-exchange skips it) and print the next
             steps. No network.
  check      one GET /v1/health through the configured proxy (or directly): proxy used,
             target, TLS verification, round trip, hub version and the client_ip the hub
             sees; on failure a hint (proxy not running / proxy refused CONNECT /
             certificate rejected / hub unreachable / IP not in allow). No token.
  register   POST /v1/enroll?id= with node, platform, capabilities, max_concurrency and the
             workspace NAMES; waits until a controller approves (DSH: agent_requests /
             agent_approve), then writes the token to DSH_AGENT_TOKEN_FILE (mode 600).
             Resumable (<token file>.enroll.json). Already registered (token accepted by
             GET /v1/me): says so and exits. `enroll` is the old name of this command.
  run        stay online: a first heartbeat (retried 5 s -> 60 s on failure), then a
             heartbeat every DSH_HEARTBEAT_SECONDS and long polls in between; tasks go to
             the exchange inbox, results come back from outbox / failed (rules below).
             Each heartbeat lists the tasks still in the exchange (`running`); tasks the hub
             answers with `abort` (cancelled, requeued, reassigned) are taken out of the
             inbox / marked ABORTED.json in working/.
  status     local settings (never the token) and GET /v1/me: the hub's view of this
             worker (status, last seen, granted workspaces and capabilities, ignored
             workspaces, held tasks, client_ip).
  leave      POST /v1/leave?id=: offline now; the hub requeues the tasks this worker held.
  bridge     one exchange sync (`--once`, for schedulers such as AWS Quick) or a simple loop.
  workspaces print the workspace map and file settings, then exit. No network.

       python agent_client.py init
       python agent_client.py check
       python agent_client.py register
       python agent_client.py run
       python agent_client.py status | leave
       python agent_client.py bridge --once

     Exchange folder contract (per task):
       inbox/<task_id>/task.json + input files     <- written by this client
       working/<task_id>/                          <- agent moves the folder here when it starts (optional)
       outbox/<task_id>/                           <- agent writes outputs: changes.patch (git diff,
                                                      relative to the workspace root), summary.md, any
                                                      other files, and result.json LAST
       failed/<task_id>/result.json                <- agent writes on failure (result.json last, too)
       archive/<task_id>/                          <- client moves it here after upload (or on abort)

     task.json is the hub task plus `workspace_path` (the real local path of the
     task's workspace, or null), `node` (this machine), `exchange` (where to put
     the result) and `effort_resolved` ({mode, thinking, agent, source}: the task's
     effort, else this worker's runtime default for the task type; source = task |
     default | none) -- the agent runs the task with it. If the task names a `ref`, the agent checks it out first; the
     client itself never runs git. A task whose workspace is not mapped on this
     machine never reaches the inbox: it is failed at once with
     error.code=WORKSPACE_MISSING, retryable=false.

  library -- for long-running workers (Claude Code wrappers, scripts):
       from agent_client import HubClient

--- configuration ---
Worker dir: <DSH home>/worker, DSH home = $DSH_HOME or ~/.dsh (--worker-dir overrides).
Two files live there, both optional and never committed:

  .env          KEY=value lines; `#` comments, `export ` prefix and '...' / "..." quotes
                as in the DSH plugin's env-file. It names the token FILE, never the token;
                still keep it private (chmod 600; on POSIX a file readable by group or
                others gets a warning).
                These DSH_HUB_* / DSH_AGENT_* variables may live ONLY in this
                worker/.env or in the process environment, never in <DSH home>/.env:
                DSH itself refuses to start when its own .env sets any DSH_* variable.
  profile.json  this machine and its workspaces (keys below). When it is missing, a
                legacy workspaces.json in the same folder is read instead (with a
                migration hint), e.g. ~/.dsh/worker/workspaces.json.

Priority of every setting: command line > process environment > worker/.env >
profile.json (hubUrl / tokenFile / proxy / node, also from a legacy workspaces.json)
> default. Relative paths from .env or a default resolve against the worker dir,
relative paths in profile.json against the folder of that file; "~" is expanded.
An empty value (DSH_HUB_CAFILE=) counts as not set.

  .env / environment     option               meaning; default
  DSH_HUB_URL            --url                hub address: host, host:port or URL; missing scheme
                                              -> https, missing port -> 7891, missing path -> /v1
                                              ("hub.example.com" -> https://hub.example.com:7891/v1).
                                              profile: hubUrl. No default (check / register / run /
                                              status / leave need it).
  DSH_HUB_PROXY          --proxy / --no-proxy how to reach the hub: http://host:port = this HTTP
                                              proxy (MYDESK: http://127.0.0.1:7890, Clash/mihomo);
                                              off = direct; env = HTTPS_PROXY / HTTP_PROXY / the
                                              system proxy (urllib rules, NO_PROXY honoured).
                                              profile: proxy (URL, or false = off). Default: env.
                                              SOCKS is not supported.
  DSH_HUB_CAFILE         --cafile             CA bundle (PEM) for a self-signed hub certificate.
                                              Default: the system CAs.
  DSH_AGENT_ID           --agent-id           registered name, ^[a-z][a-z0-9-]{1,47}$, e.g.
                                              quick-mydesk. Default: read from the token prefix
                                              (dsha_<id>_...); register needs it.
  DSH_NODE               --node               this machine's node name. profile: node.
                                              Default: the host name in lower case.
  DSH_PLATFORM           --platform           aws-quick | claude-code | kiro | custom ...
                                              Default: custom.
  DSH_CAPABILITIES       --capabilities       comma separated, for pool:<capability> tasks and
                                              task.capability; name:N caps that kind of work
                                              at N at once, e.g. browser:1,test,code.
                                              Default: none (any kind sent to it by id).
  DSH_MAX_CONCURRENCY    --max-concurrency    tasks at once, 1..32 (approval may lower it).
                                              Default: 1.
  DSH_AGENT_TOKEN_FILE   --token-file         worker token file: register writes it (mode 600),
                                              run / status / leave / bridge read it. The token is
                                              read ONLY from this file and never printed.
                                              profile: tokenFile. Default: agent.token.
  DSH_EXCHANGE           --exchange           exchange folder of run / bridge.
                                              Default: exchange (in the worker dir).
  DSH_HEARTBEAT_SECONDS  --heartbeat-seconds  heartbeat period of run, 5..3600 seconds; the hub
                                              marks a worker offline after 90 s without a
                                              heartbeat / poll. Default: 30.
  DSH_ROLE               --role               worker | coder | tester | dispatcher | observer, asked at
                                              register (approval may narrow it). Default: worker.
                                              coder = edits code only (AWS Quick: no shell): the hub
                                              never hands it a task that runs tests, commands or git.
  DSH_PULL_EVERY_SECONDS --pull-every-seconds how often this worker comes back when it is not
                                              always on (cron / scheduled `bridge --once`),
                                              60..86400; the hub then waits 90 s + this long
                                              before it counts the worker offline. Empty = an
                                              always-on worker (`run`). Default: empty.
  DSH_PATH_MAP           (environment / .env) host path prefixes -> local prefixes, for a worker
                                              in a container reading the HOST profile.json /
                                              dshProfile: "E:/=/host/e;C:/Users/me/.dsh=/host/dsh"
                                              (';' separated, longest prefix wins, drive letters
                                              and backslash vs / ignored). Applied to dshProfile, partition
                                              roots and workspaces paths before the existence
                                              check; task.json keeps the host path as
                                              workspace_host_path. Default: none.

profile.json keys (all optional; unknown keys are ignored):
  node        node name (see DSH_NODE).
  dshProfile  local DSH profile folder, or its cordis.patch.yml. The router-b partitions
              in it (host-router entry, partitions[].name -> partitions[].root) form the
              base workspace map. Legacy name: profile. Default: none.
  workspaces  Object {name: local path}. Overrides a dshProfile partition of the same
              name and adds new names; null hides a name the dshProfile would provide.
              An explicit path that does not exist is dropped; it does NOT fall back
              to the dshProfile path. Default: {}.
  runtime     what this worker can be asked to run, sent at register and in every
              heartbeat (shown by agent_list / agent_requests in DSH; checked by the hub
              against task effort):
                {"modes": ["fast", "balanced", "smart"], "thinking": ["off", "low", "medium", "high"],
                 "default": {"mode": "balanced", "thinking": "low"},
                 "defaults": {"code": {"mode": "smart", "thinking": "medium"}},
                 "agents": [{"name": "quick", "description": "..."}], "note": "..."}
              Default: the built-in runtime of DSH_PLATFORM (aws-quick has one; other
              platforms declare nothing). null = declare nothing.
  capabilities, maxConcurrency, role, pullEverySeconds, platform, agentId
              what this machine's worker is, so each machine's own profile.json says it
              (fallbacks of the DSH_* settings of the same meaning). capabilities is a
              list ["browser:1", "test", "code"] or an object {"browser": 1, "test": null}.
              A local DSH that runs browser tasks, tests and code: see
              scripts/profile.local-dsh.example.json.
  hubUrl, tokenFile, proxy
              lowest-priority fallbacks of DSH_HUB_URL, DSH_AGENT_TOKEN_FILE and
              DSH_HUB_PROXY (proxy false = off), kept for older workspaces.json files.

Workspace map (contract section 3), highest priority first:
  1. "workspaces" in profile.json;
  2. router-b partitions of "dshProfile".
Workspaces whose path does not exist are dropped with a warning and never
reported. Only workspace NAMES leave this machine (register and every heartbeat);
paths only go into the local task.json as workspace_path (local / container path) and
workspace_host_path (the path as written in the profile, i.e. on the host).

Examples: scripts/worker.env.example and scripts/profile.example.json (legacy:
scripts/workspaces.example.json). Check the merged result offline with:
  python agent_client.py workspaces
--- end ---
"""
import argparse, base64, json, os, re, shutil, socket, ssl, sys, time, urllib.error, urllib.parse, urllib.request

PROTOCOL = "dsh-agent/2.0"
CLIENT_VERSION = "agent_client/2.1.0"
DEFAULT_PORT = 7891  # 7890 is the local Clash/mihomo proxy on MYDESK, not the hub
API_PREFIX = "/v1"
TOKEN_HEADER = "X-DSH-Token"
DEFAULT_WAIT = 25
MAX_WAIT = 55
POLL_SLACK = 15  # client timeout = wait + this, so a long poll is never cut short by us
DEFAULT_WORKSPACES_FILE = os.path.join("~", ".dsh", "worker", "workspaces.json")
AGENT_ID_RE = re.compile(r"[a-z][a-z0-9-]{1,47}")
# Same whitelist as the hub (hub.js FILE_NAME_RE): anything else would 400 the whole upload.
FILE_NAME_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff][A-Za-z0-9\u4e00-\u9fff _.()-]{0,127}")
MAX_RESULT_FILES = 50
SUMMARY_MAX = 4000
WORKSPACE_MISSING = "WORKSPACE_MISSING"
EXCHANGE_DIRS = ("inbox", "working", "outbox", "failed", "archive")
TASK_ID_RE = re.compile(r"[A-Za-z0-9_.-]{1,96}")
ABORT_MARK = "ABORTED.json"
DEFAULT_HEARTBEAT = 30
# Keys worker/.env carries (what `init` writes). The older agent keys (DSH_AGENT_ID, DSH_NODE, ...) are
# still read from the environment / .env for one release; `doctor` says where they belong now.
ENV_KEYS = ("DSH_HUB_URL", "DSH_HUB_PROXY", "DSH_HUB_CAFILE", "DSH_AGENT")
ROLES = ("worker", "coder", "tester", "dispatcher", "observer")
PROXY_OFF = ("off", "direct", "none", "false", "no")
EFFORT_MODES = ("fast", "balanced", "smart")
EFFORT_THINKING = ("off", "low", "medium", "high")
# Built-in runtime declarations per platform (profile.json "runtime" overrides; null = none).
PLATFORM_RUNTIMES = {
    "aws-quick": {
        "modes": list(EFFORT_MODES), "thinking": list(EFFORT_THINKING),
        "default": {"mode": "balanced", "thinking": "low"},
        "defaults": {"code": {"mode": "smart", "thinking": "medium"}, "review": {"mode": "smart", "thinking": "low"}},
        "agents": [],
        "note": "AWS Quick: picked up by a schedule; runs each task in the requested mode",
    },
}
PROXY_ENV = ("env", "system")


def warn(message):
    print(f"warning: {message}", file=sys.stderr)


class HubError(Exception):
    def __init__(self, status, code, message):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code = status, code


class ConfigError(Exception):
    """Local configuration problem (bad workspaces.json, bad URL, ...)."""


# --- URLs and proxies ---------------------------------------------------------

def hub_url(value):
    """Normalize the hub address: default scheme https, port 7891, path /v1."""
    v = (value or "").strip()
    if not v:
        raise ConfigError("hub URL is required (--url or DSH_HUB_URL)")
    if "://" not in v:
        v = "https://" + v
    u = urllib.parse.urlsplit(v)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ConfigError(f"not a hub URL: {value}")
    if u.query or u.fragment or u.username or u.password:
        raise ConfigError("hub URL must not carry a query, fragment or credentials")
    try:
        port = u.port
    except ValueError:
        raise ConfigError(f"bad port in hub URL: {value}") from None
    netloc = u.netloc if port is not None else f"{u.netloc}:{DEFAULT_PORT}"
    path = u.path.rstrip("/") or API_PREFIX
    return urllib.parse.urlunsplit((u.scheme, netloc, path, "", ""))


def normalize_proxy(value):
    v = (value or "").strip()
    if "://" not in v:
        v = "http://" + v
    u = urllib.parse.urlsplit(v)
    if u.scheme not in ("http", "https") or not u.hostname:
        raise ConfigError("--proxy must look like http://127.0.0.1:7890 (urllib has no SOCKS support)")
    return v


def mask_url(value):
    """Drop credentials from a proxy URL before printing it."""
    u = urllib.parse.urlsplit(value)
    if u.username is None and u.password is None:
        return value
    host = u.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    netloc = "***@" + host + (f":{u.port}" if u.port else "")
    return urllib.parse.urlunsplit((u.scheme, netloc, u.path, u.query, u.fragment))


def proxy_notice(url, proxy=None, no_proxy=False, env_proxies=None, bypass=None):
    """Return a one-line note about which proxy the hub traffic will use, or None."""
    if no_proxy:
        return None
    if proxy:
        return f"hub traffic goes through --proxy {mask_url(proxy)}; the hub IP allowlist sees the proxy's exit IP"
    u = urllib.parse.urlsplit(url)
    proxies = urllib.request.getproxies() if env_proxies is None else env_proxies
    chosen = proxies.get(u.scheme)
    if not chosen:
        return None
    if bypass is None:
        try:
            bypassed = bool(urllib.request.proxy_bypass(u.hostname or ""))
        except Exception:
            bypassed = False
    else:
        bypassed = bool(bypass(u.hostname or ""))
    if bypassed:
        return None
    return (f"urllib will send hub traffic through {mask_url(chosen)} (taken from {u.scheme.upper()}_PROXY or the "
            f"system proxy settings); the hub IP allowlist then sees the proxy's exit IP. "
            f"Pass --no-proxy to connect directly or --proxy URL to choose one explicitly")


def make_ssl_context(cafile=None, insecure=False):
    ctx = ssl.create_default_context(cafile=cafile) if cafile else ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def proxy_handler(proxy=None, no_proxy=False):
    """ProxyHandler for an explicit choice, or None to keep urllib's default (env + system proxies)."""
    if no_proxy:
        return urllib.request.ProxyHandler({})
    if proxy:
        return urllib.request.ProxyHandler({"http": proxy, "https": proxy})
    return None


def build_opener(ctx, proxy=None, no_proxy=False):
    handlers = [urllib.request.HTTPSHandler(context=ctx)]
    ph = proxy_handler(proxy, no_proxy)
    if ph is not None:
        handlers.append(ph)  # an explicit ProxyHandler (even an empty one) replaces urllib's default
    return urllib.request.build_opener(*handlers)


def agent_id_from_token(token):
    if isinstance(token, str) and token.startswith("dsha_"):
        candidate = token[5:].split("_", 1)[0]
        if AGENT_ID_RE.fullmatch(candidate):
            return candidate
    return None


# --- HTTP client ----------------------------------------------------------------

class HubClient:
    """Worker side of /v1/*. Token-less calls (enroll) work with token=None."""

    def __init__(self, url, token=None, insecure=False, cafile=None, timeout=60, *, agent_id=None,
                 proxy=None, no_proxy=False, workspaces=(), opener=None, ctx=None, runtime=None,
                 role=None, pull_every_seconds=None, dsh_profile=None):
        self.url = hub_url(url)
        self.dsh_profile = dsh_profile
        self.runtime = runtime
        self.role = role
        self.pull_every_seconds = pull_every_seconds
        self.token = token
        derived = agent_id_from_token(token)
        if agent_id is None:
            agent_id = derived
        if agent_id is None or not AGENT_ID_RE.fullmatch(agent_id):
            raise ConfigError("agent id must match ^[a-z][a-z0-9-]{1,47}$ (--agent-id / DSH_AGENT_ID)")
        if derived is not None and derived != agent_id:
            raise ConfigError(f"the token belongs to agent {derived!r}, not {agent_id!r}")
        self.agent_id = agent_id
        self.timeout = timeout
        self.workspaces = list(workspaces)
        self.ctx = ctx or make_ssl_context(cafile, insecure)
        self.opener = opener or build_opener(self.ctx, proxy, no_proxy)

    def url_for(self, path, query=None):
        q = [("id", self.agent_id)] + [(k, v) for k, v in (query or {}).items() if v is not None]
        return f"{self.url}/{path.lstrip('/')}?{urllib.parse.urlencode(q)}"

    def _req(self, method, path, body=None, raw=False, query=None, auth=True, timeout=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(self.url_for(path, query), data=data, method=method)
        req.add_header("Accept", "application/json")
        req.add_header("User-Agent", f"dsh-agent-client/{PROTOCOL}")
        if auth:
            if not self.token:
                raise ConfigError("this call needs a worker token")
            req.add_header(TOKEN_HEADER, self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as res:
                payload = res.read()
        except urllib.error.HTTPError as e:
            try:
                err = json.loads(e.read().decode("utf-8")).get("error", {})
            except Exception:
                err = {}
            raise HubError(e.code, err.get("code", "http"), err.get("message", e.reason)) from None
        return payload if raw else json.loads(payload.decode("utf-8"))

    # enrollment (no token)
    def enroll_request(self, platform, mode, node, workspaces, capabilities, max_concurrency, description):
        body = {"platform": platform, "mode": mode, "node": node, "workspaces": list(workspaces),
                "capabilities": list(capabilities), "max_concurrency": max_concurrency, "description": description}
        if self.runtime is not None:
            body["runtime"] = self.runtime
        if self.role is not None:
            body["role"] = self.role
        if self.pull_every_seconds is not None:
            body["pull_every_seconds"] = self.pull_every_seconds
        if self.dsh_profile is not None:
            body["dsh_profile"] = self.dsh_profile
        return self._req("POST", "enroll", body, auth=False)

    def enroll_status(self, request_id, poll_secret):
        return self._req("POST", "enroll/status", {"request_id": request_id, "poll_secret": poll_secret}, auth=False)

    # worker calls (token)
    def heartbeat(self, status="idle", workspaces=None, running=None):
        """`running` (task ids still held locally) lets the hub reconcile: it answers `abort`."""
        names = self.workspaces if workspaces is None else list(workspaces)
        body = {"status": status, "workspaces": names, "client_version": CLIENT_VERSION}
        if self.runtime is not None:
            body["runtime"] = self.runtime  # descriptive: the hub keeps the latest one
        if self.pull_every_seconds is not None:
            body["pull_every_seconds"] = self.pull_every_seconds  # so the hub does not count us offline between visits
        if running is not None:
            body["running"] = list(running)
        if self.dsh_profile is not None:
            body["dsh_profile"] = self.dsh_profile
        if self.role is not None:
            body["role"] = self.role  # the hub takes it only if it narrows the grant (worker -> coder)
        return self._req("POST", "heartbeat", body)

    def me(self):
        """GET /v1/me: the hub's view of this worker (status, grants, held tasks, client_ip)."""
        return self._req("GET", "me")

    def leave(self, reason=None):
        """POST /v1/leave: offline now; the hub requeues the tasks this worker holds."""
        return self._req("POST", "leave", {"reason": reason} if reason else {})

    def poll(self, max_tasks=1, wait=DEFAULT_WAIT):
        wait = max(0, min(MAX_WAIT, int(wait)))
        max_tasks = max(1, int(max_tasks))
        res = self._req("GET", "poll", query={"max": max_tasks, "wait": wait}, timeout=max(self.timeout, wait + POLL_SLACK))
        return res.get("tasks", [])

    def progress(self, task_id, progress=None, message=None, stage=None, renew=False):
        """POST /v1/event. `renew=True` with nothing else only keeps the lease (no event on the hub)."""
        body = {"task_id": task_id}
        if progress is not None:
            body["progress"] = progress
        if message is not None:
            body["message"] = message
        if stage is not None:
            body["stage"] = stage
        if renew:
            body["renew"] = True
        return self._req("POST", "event", body)

    def session(self, task_id, entries):
        """POST /v1/session: append session log entries ({role, text, name?, at?}) to the task on the hub."""
        return self._req("POST", "session", {"task_id": task_id, "entries": list(entries)})

    def artifact(self, task_id, name, from_task=None):
        q = {"task_id": task_id, "name": name}
        if from_task and from_task != task_id:
            q["from_task"] = from_task
        return self._req("GET", "artifact", query=q, raw=True)

    def result(self, task_id, status, summary="", files=(), error=None, needs_input=None):
        body = {"task_id": task_id, "status": status, "summary": summary, "files": list(files)}
        if error:
            body["error"] = error
        if needs_input:
            body["needs_input"] = needs_input
        return self._req("POST", "result", body)


def enroll(client, platform, mode, node, workspaces, capabilities, max_concurrency, description,
           token_file, state_file, wait, interval, log=print):
    """Request -> wait for controller approval -> save token. Resumable via state_file."""
    state = None
    if os.path.isfile(state_file):
        with open(state_file, encoding="utf-8") as f:
            state = json.load(f)
    if state is None:
        r = client.enroll_request(platform, mode, node, workspaces, capabilities, max_concurrency, description)
        state = {"request_id": r["request_id"], "poll_secret": r["poll_secret"]}
        os.makedirs(os.path.dirname(os.path.abspath(state_file)), exist_ok=True)
        write_atomic(state_file, json.dumps(state))
        _private(state_file)
        log(f"enrollment requested: {r['request_id']} for {client.agent_id} on node {node} "
            f"(workspaces: {', '.join(workspaces) or '-'}) -- waiting for approval")
    while True:
        s = client.enroll_status(state["request_id"], state["poll_secret"])
        if s.get("token"):
            os.makedirs(os.path.dirname(os.path.abspath(token_file)), exist_ok=True)
            write_atomic(token_file, s["token"] + "\n")
            _private(token_file)
            os.remove(state_file)
            log(f"approved: agent {s.get('agent_id', client.agent_id)}; token saved to {token_file}")
            return 0
        if s.get("status") in ("rejected", "expired", "revoked") or s.get("token_issued"):
            log(f"enrollment {s.get('status')}{': ' + s['reason'] if s.get('reason') else ''}")
            os.remove(state_file)
            return 1
        if not wait:
            log("still pending")
            return 2
        time.sleep(interval)


def _private(path):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


# --- minimal YAML reader for router-b partitions -------------------------------
#
# Not a YAML parser: it only finds `partitions:` sequences in a cordis patch file
# and reads `name` / `root` of each item. Block scalars (`>-`, `|`, ...) are
# skipped, comments ignored, single / double quoted scalars understood. Flow
# style (`partitions: [...]`) is not supported (warned).

_KEY_RE = re.compile(r"""(?P<key>"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:,\[\]{}][^:]*?)[ \t]*:(?:[ \t]+(?P<val>.*))?""")
_BLOCK_RE = re.compile(r"[|>][0-9+-]*\s*(?:#.*)?")
_DASH_RE = re.compile(r"-(?:[ \t]+|$)")
_NULLS = ("~", "null", "Null", "NULL")
_DQ_ESC = {"n": "\n", "t": "\t", "r": "\r", "0": "\0", '"': '"', "\\": "\\", "/": "/", " ": " ", "b": "\b", "e": "\x1b"}


class _Tok:
    __slots__ = ("line", "col", "dash", "key", "raw")

    def __init__(self, line, col, dash, key, raw):
        self.line, self.col, self.dash, self.key, self.raw = line, col, dash, key, raw


def yaml_scalar(raw):
    """Plain / quoted YAML scalar -> str, or None for empty / null. Raises ValueError on a broken quote."""
    s = (raw or "").strip()
    if s == "" or s.startswith("#"):
        return None
    if s[0] == '"':
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "\\" and i + 1 < len(s):
                n = s[i + 1]
                if n in _DQ_ESC:
                    out.append(_DQ_ESC[n]); i += 2; continue
                width = {"x": 2, "u": 4, "U": 8}.get(n)
                if width:
                    h = s[i + 2:i + 2 + width]
                    if len(h) == width and all(ch in "0123456789abcdefABCDEF" for ch in h):
                        out.append(chr(int(h, 16))); i += 2 + width; continue
                out.append(c); i += 1; continue  # lenient: unknown escape keeps the backslash
            if c == '"':
                rest = s[i + 1:].strip()
                if rest and not rest.startswith("#"):
                    raise ValueError(f"text after closing quote: {s[:80]}")
                return "".join(out)
            out.append(c); i += 1
        raise ValueError(f"unterminated double quote: {s[:80]}")
    if s[0] == "'":
        out, i = [], 1
        while i < len(s):
            c = s[i]
            if c == "'":
                if s[i + 1:i + 2] == "'":
                    out.append("'"); i += 2; continue
                rest = s[i + 1:].strip()
                if rest and not rest.startswith("#"):
                    raise ValueError(f"text after closing quote: {s[:80]}")
                return "".join(out)
            out.append(c); i += 1
        raise ValueError(f"unterminated single quote: {s[:80]}")
    s = re.split(r"\s+#", s, maxsplit=1)[0].rstrip()
    return None if s in _NULLS or s == "" else s


def _tokens(text):
    """Key lines and list items of a YAML document; block-scalar bodies removed."""
    toks, skip_deeper = [], None
    for no, line in enumerate(text.lstrip("\ufeff").splitlines()):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(" "))
        if skip_deeper is not None:
            if not stripped or indent > skip_deeper:
                continue
            skip_deeper = None
        if not stripped or stripped.startswith("#") or stripped in ("---", "..."):
            continue
        col, rest, dash = indent, line[indent:], None
        m = _DASH_RE.match(rest)
        if m:
            dash, col, rest = col, col + m.end(), rest[m.end():]
            if not rest.strip():
                toks.append(_Tok(no, None, dash, None, ""))
                continue
        km = _KEY_RE.fullmatch(rest.rstrip())
        if km:
            key = km.group("key")
            if key[:1] in ("'", '"'):
                try:
                    key = yaml_scalar(key) or ""
                except ValueError:
                    pass
            raw = (km.group("val") or "").strip()
            toks.append(_Tok(no, col, dash, key, raw))
            if _BLOCK_RE.fullmatch(raw):
                skip_deeper = col  # body lines are indented deeper than the key
        else:
            toks.append(_Tok(no, col, dash, None, rest.strip()))
    return toks


def _owner(toks, i):
    """id / name of the patch entry that encloses toks[i] (nearest mapping with either)."""
    level, found = toks[i].col, {}
    for u in reversed(toks[:i]):
        if u.key is None or u.col is None:
            continue
        if u.col < level:
            level = u.col
        if u.col == level:
            if u.key in ("id", "name") and u.key not in found:
                try:
                    found[u.key] = yaml_scalar(u.raw)
                except ValueError:
                    found[u.key] = None
            if u.dash is not None:
                if found:
                    return found
                level = u.dash
    return found


def _sequence(toks, i, log):
    """Items (raw key -> raw value, top level of each item) of the sequence under toks[i]."""
    P = toks[i].col
    items, cur, D, K = [], None, None, None
    j = i + 1
    while j < len(toks):
        u = toks[j]
        lead = u.dash if u.dash is not None else u.col
        if lead < P or (lead == P and u.dash is None):
            break
        if u.dash is not None and (D is None or u.dash == D):
            D = u.dash
            cur = {}
            items.append((u.line, cur))
            K = u.col if u.key is not None else None
            if u.key is not None:
                cur[u.key] = u.raw
        elif D is None:
            log(f"cordis.patch.yml line {toks[i].line + 1}: partitions is not a list; ignored")
            break
        elif u.dash is not None and u.dash < D:
            break
        else:
            if K is None and u.key is not None and u.dash is None:
                K = u.col
            if u.key is not None and u.dash is None and u.col == K:
                cur[u.key] = u.raw
        j += 1
    return items, j


def _is_host_router(owner):
    return owner.get("id") == "host-router" or "host-router" in str(owner.get("name") or "")


def parse_partitions(text, log=warn):
    """router-b partitions in a cordis patch file -> [{"name", "root"}] (root may be None).

    Uses the `partitions` of the host-router entry; when no entry is identified at
    all, any bare `partitions:` list counts. Later entries win on duplicate names."""
    toks = _tokens(text)
    blocks, i = [], 0
    while i < len(toks):
        t = toks[i]
        if t.key == "partitions" and t.col is not None:
            raw = t.raw
            if raw and not raw.startswith("#"):
                if raw.startswith("[") and raw.rstrip().rstrip("]").strip("[ ") == "":
                    blocks.append((_owner(toks, i), []))
                elif raw.startswith("["):
                    log(f"cordis.patch.yml line {t.line + 1}: flow-style partitions are not supported; ignored")
                i += 1
                continue
            items, j = _sequence(toks, i, log)
            blocks.append((_owner(toks, i), items))
            i = max(j, i + 1)
            continue
        i += 1
    chosen = [items for owner, items in blocks if _is_host_router(owner)]
    if not chosen:
        chosen = [items for owner, items in blocks if not owner]
    merged = {}
    for items in chosen:
        for line, item in items:
            try:
                name = yaml_scalar(item.get("name"))
                root = yaml_scalar(item.get("root"))
            except ValueError as e:
                log(f"cordis.patch.yml line {line + 1}: {e}; partition ignored")
                continue
            if not name or not name.strip():
                log(f"cordis.patch.yml line {line + 1}: partition without a name; ignored")
                continue
            merged.pop(name, None)
            merged[name] = root
    return [{"name": n, "root": r} for n, r in merged.items()]


# --- workspace map ---------------------------------------------------------------

def _is_abs(path):
    return os.path.isabs(path) or path.startswith(("/", "\\"))


def parse_path_map(value):
    """DSH_PATH_MAP "host=local;host2=local2" -> [(host, local)], longest host prefix first."""
    pairs = []
    for part in re.split(r"[;\n]", value or ""):
        part = part.strip()
        if not part:
            continue
        host, sep, local = part.partition("=")
        host, local = host.strip().replace("\\", "/").rstrip("/"), local.strip()
        if not sep or not host or not local:
            raise ConfigError(f"DSH_PATH_MAP entry {part!r} must be <host path>=<local path>")
        pairs.append((host, local.rstrip("/") or "/"))
    return sorted(pairs, key=lambda p: -len(p[0]))


def map_path(path, path_map):
    """Rewrite a host path through DSH_PATH_MAP (unchanged when no prefix matches)."""
    if not path_map or not isinstance(path, str):
        return path
    s = path.strip().replace("\\", "/")
    for host, local in path_map:
        fold = re.match(r"^[A-Za-z]:", host) is not None  # Windows paths: case-insensitive
        a, h = (s.lower(), host.lower()) if fold else (s, host)
        if a == h or a.startswith(h + "/"):
            return local + s[len(host):]
    return path


def _local_path(path, base=None):
    p = os.path.expanduser(path.strip())
    if base is not None and not _is_abs(p):
        p = os.path.join(base, p)
    return os.path.abspath(p)


class WorkspaceMap:
    def __init__(self, node, config_path, profile, workspaces, sources, dropped, hub_url=None, token_file=None, proxy=None,
                 file_node=None, legacy=False, exists=False, host_paths=None, runtime=None, has_runtime=False,
                 machine=None):
        self.node, self.config_path, self.profile = node, config_path, profile
        self.workspaces, self.sources, self.dropped = workspaces, sources, dropped
        # connection settings from profile.json / workspaces.json (None = not set; proxy False = direct)
        self.hub_url, self.token_file, self.proxy = hub_url, token_file, proxy
        self.file_node, self.legacy, self.exists = file_node, legacy, exists
        # name -> path as written in the profile (differs from workspaces[name] only with DSH_PATH_MAP)
        self.host_paths = dict(host_paths or {})
        # profile.json "runtime": has_runtime False = key absent (use the platform default)
        self.runtime, self.has_runtime = runtime, has_runtime
        # what this machine's worker is (capabilities / maxConcurrency / role / pullEverySeconds / platform /
        # agentId), lowest-priority fallbacks of the DSH_* settings; None = not set in the file
        self.machine = dict(machine or {})
        self.profile_name = None  # name of the dshProfile (folder name), sent to the hub as dsh_profile
        self.agent_file = False   # True when read from <worker>/agents/<id>.json
        self.path_map = []

    def names(self):
        """Names safe to report: mapped and still present on disk."""
        return sorted(n for n, p in self.workspaces.items() if os.path.isdir(p))

    def to_json(self):
        proxy = self.proxy if self.proxy in (None, False) else mask_url(self.proxy)
        return {"node": self.node, "workspaces_file": self.config_path, "profile": self.profile, "dsh_profile": self.profile_name,
                "workspaces": dict(sorted(self.workspaces.items())), "sources": dict(sorted(self.sources.items())),
                "dropped": self.dropped,
                "runtime": self.runtime if self.has_runtime else "(platform default)",
                "host_paths": {n: p for n, p in sorted(self.host_paths.items()) if n in self.workspaces and p != self.workspaces[n]},
                "file_settings": {"hubUrl": self.hub_url, "tokenFile": self.token_file, "proxy": proxy,
                                  **{k: v for k, v in sorted(self.machine.items()) if v is not None}}}


def profile_patch_path(profile):
    return profile if profile.lower().endswith((".yml", ".yaml")) else os.path.join(profile, "cordis.patch.yml")


def default_node():
    return (socket.gethostname() or "local").split(".")[0].lower()


def dsh_home(env=None):
    env = os.environ if env is None else env
    home = env.get("DSH_HOME")
    return os.path.abspath(os.path.expanduser(home)) if isinstance(home, str) and home.strip() else os.path.abspath(os.path.expanduser(os.path.join("~", ".dsh")))


def default_worker_dir(env=None):
    """<DSH home>/worker: .env, profile.json, the token file and (by default) the exchange folder."""
    return os.path.join(dsh_home(env), "worker")


# --- worker folder layout -----------------------------------------------------------
#
# <DSH home>/
#   .env                        DSH's own; never any DSH_* variable
#   profiles/<profile>/         local DSH profiles; their router-b partitions are the workspaces
#   worker/
#     .env                      how to reach the hub only: DSH_HUB_URL, DSH_HUB_PROXY, DSH_HUB_CAFILE (+ DSH_AGENT)
#     agents/<agent-id>.json    what each agent is: dshProfile (required), capabilities, role, ...
#     tokens/<agent-id>.token   its token (mode 600)
#     exchange/<agent-id>/      its own inbox / working / outbox / failed / archive
#     logs/<agent-id>.log       worker_run.py log; logs/<agent-id>.executor.log for worker_executor.py

AGENTS_DIR, TOKENS_DIR, LOGS_DIR, EXCHANGE_BASE, PROFILES_DIR = "agents", "tokens", "logs", "exchange", "profiles"
PROFILE_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
# Settings that describe one agent: they live in agents/<id>.json, not in worker/.env.
AGENT_ENV_KEYS = {"DSH_NODE": "node", "DSH_PLATFORM": "platform", "DSH_CAPABILITIES": "capabilities",
                  "DSH_MAX_CONCURRENCY": "maxConcurrency", "DSH_ROLE": "role", "DSH_PULL_EVERY_SECONDS": "pullEverySeconds",
                  "DSH_EXCHANGE": "exchange", "DSH_PATH_MAP": "pathMap", "DSH_HEARTBEAT_SECONDS": "heartbeatSeconds"}
CONNECTION_ENV_KEYS = ("DSH_HUB_URL", "DSH_HUB_PROXY", "DSH_HUB_CAFILE", "DSH_AGENT")


def agent_paths(worker_dir, agent_id):
    """Where one agent's files live inside the worker folder."""
    return {"config": os.path.join(worker_dir, AGENTS_DIR, f"{agent_id}.json"),
            "token": os.path.join(worker_dir, TOKENS_DIR, f"{agent_id}.token"),
            "exchange": os.path.join(worker_dir, EXCHANGE_BASE, agent_id),
            "log": os.path.join(worker_dir, LOGS_DIR, f"{agent_id}.log"),
            "executor_log": os.path.join(worker_dir, LOGS_DIR, f"{agent_id}.executor.log")}


def agent_configs(worker_dir):
    """Agent ids that have a config file in <worker>/agents/, sorted."""
    d = os.path.join(worker_dir, AGENTS_DIR)
    if not os.path.isdir(d):
        return []
    return sorted(n[:-5] for n in os.listdir(d) if n.endswith(".json") and AGENT_ID_RE.fullmatch(n[:-5]))


def select_agent(worker_dir, env=None, dotenv=None, cli_agent=None):
    """(agent id, source) of the agent this run is for, or (None, None) without agents/ (legacy layout).

    --agent > DSH_AGENT (environment, then worker/.env) > the only file in agents/.
    A named agent must have its agents/<id>.json; several files and none named is an error."""
    env = os.environ if env is None else env
    dotenv = dotenv or {}
    for label, value in (("cli", cli_agent), ("env", env.get("DSH_AGENT")), (".env", dotenv.get("DSH_AGENT"))):
        if isinstance(value, str) and value.strip():
            value = value.strip()
            if not AGENT_ID_RE.fullmatch(value):
                raise ConfigError(f"agent name {value!r} (from {label}) must match ^[a-z][a-z0-9-]{{1,47}}$")
            if not os.path.isfile(agent_paths(worker_dir, value)["config"]):
                have = agent_configs(worker_dir)
                raise ConfigError(f"no config for agent {value} (from {label}): {agent_paths(worker_dir, value)['config']} is missing"
                                  + (f"; configured agents: {', '.join(have)}" if have else
                                     f"; create it with: python agent_client.py init --agent {value}"))
            return value, label
    have = agent_configs(worker_dir)
    if len(have) == 1:
        return have[0], "agents/"
    if len(have) > 1:
        raise ConfigError(f"several agents are configured in {os.path.join(worker_dir, AGENTS_DIR)}: {', '.join(have)}; "
                          "pick one with --agent <id> or DSH_AGENT=<id>")
    return None, None


def resolve_dsh_profile(value, base, home, path_map=None):
    """dshProfile -> (local folder or .yml path, profile name). A bare name means <DSH home>/profiles/<name>."""
    v = value.strip()
    if PROFILE_NAME_RE.fullmatch(v) and not v.lower().endswith((".yml", ".yaml")):
        named = os.path.join(home, PROFILES_DIR, v)
        older = _local_path(v, base)  # an older profile.json may name a folder next to it
        return (older if not os.path.isdir(named) and os.path.isdir(older) else named), v
    path = _local_path(map_path(v, path_map), base)
    folder = os.path.dirname(path) if path.lower().endswith((".yml", ".yaml")) else path
    name = os.path.basename(folder.rstrip("\\/")) or None
    return path, name if name and PROFILE_NAME_RE.fullmatch(name) else None


_ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def parse_env_text(text):
    """`.env` text -> dict. Same rules as the DSH plugin's env-file.js (comments, export, quotes, last wins)."""
    out = {}
    for raw in (text or "").lstrip("\ufeff").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if re.match(r"export\s+", line):
            line = re.sub(r"^export\s+", "", line)
        eq = line.find("=")
        if eq <= 0:
            continue
        key = line[:eq].strip()
        if not _ENV_KEY_RE.fullmatch(key):
            continue
        value = line[eq + 1:].strip()
        if value[:1] in ("'", '"'):
            end = value.find(value[0], 1)
            if end < 0:
                continue  # unterminated quote: skip rather than guess
            rest = value[end + 1:].strip()
            if rest and not rest.startswith("#"):
                continue
            value = value[1:end]
        elif value.startswith("#"):
            value = ""  # `KEY=   # comment`: empty value (= not set), the rest is a comment
        else:
            m = re.search(r"\s#", value)
            if m:
                value = value[:m.start()].rstrip()
        out[key] = value
    return out


def read_env_file(path, log=warn, platform=None):
    """worker/.env -> dict ({} when missing). Values are never logged."""
    if not os.path.isfile(path):
        return {}
    platform = sys.platform if platform is None else platform
    try:
        mode = os.stat(path).st_mode
        if not platform.startswith("win") and mode & 0o077:
            log(f"{path} is readable by group or others (mode {mode & 0o777:03o}); run: chmod 600 {path}")
        with open(path, encoding="utf-8-sig") as f:
            return parse_env_text(f.read())
    except OSError as e:
        raise ConfigError(f"cannot read {path}: {e}") from None


def _opt_str(config, key, path):
    value = config.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{path}: {key} must be a non-empty string")
    return value.strip()


def profile_file_for(worker_dir, log=warn):
    """(path, legacy?) of the profile: profile.json, else a legacy workspaces.json (with a hint)."""
    current = os.path.join(worker_dir, "profile.json")
    legacy = os.path.join(worker_dir, "workspaces.json")
    if os.path.isfile(current):
        return current, False
    if os.path.isfile(legacy):
        log(f"using legacy {legacy}; rename it to profile.json (and its \"profile\" key to \"dshProfile\"), and move "
            "hubUrl / tokenFile / proxy into .env as DSH_HUB_URL / DSH_AGENT_TOKEN_FILE / DSH_HUB_PROXY")
        return legacy, True
    return current, False


def resolve_workspaces(config_path=None, node=None, required=False, log=warn, isdir=os.path.isdir, worker_dir=None, path_map=None,
                       home=None):
    """Merge the agent config's "workspaces" (explicit, wins) over the dshProfile's router-b partitions.

    `config_path` names the file (agents/<id>.json, profile.json or a legacy workspaces.json); without
    it the worker dir is searched: profile.json, then workspaces.json. Relative paths in a file under
    agents/ resolve against the worker dir, in any other file against that file's folder.
    `home` is the DSH home a bare dshProfile name is looked up in (<home>/profiles/<name>)."""
    legacy = False
    if config_path:
        path = _local_path(config_path)
        legacy = os.path.basename(path).lower() == "workspaces.json"
    else:
        path, legacy = profile_file_for(worker_dir or default_worker_dir(), log)
    config, exists = {}, os.path.isfile(path)
    if exists:
        try:
            with open(path, encoding="utf-8-sig") as f:
                config = json.load(f)
        except (OSError, ValueError) as e:
            raise ConfigError(f"cannot read {path}: {e}") from None
        if not isinstance(config, dict):
            raise ConfigError(f"{path}: top level must be an object")
    elif required:
        raise ConfigError(f"profile file not found: {path}")
    else:
        log(f"no profile at {path}; no workspaces are mapped (python agent_client.py init writes a template)")
    base = os.path.dirname(path)
    in_agents = os.path.basename(base) == AGENTS_DIR
    if in_agents:
        base = os.path.dirname(base)  # agents/<id>.json: relative paths are relative to the worker dir
    if path_map is None or not path_map:
        pm = config.get("pathMap")
        if pm is not None and not isinstance(pm, str):
            raise ConfigError(f"{path}: pathMap must be a string like \"E:/=/host/e\"")
        path_map = parse_path_map(pm or "")

    candidates, sources, dropped, hosts = {}, {}, [], {}
    profile = config.get("dshProfile", config.get("profile"))
    profile_name = None
    if profile is not None and not isinstance(profile, str):
        raise ConfigError(f"{path}: dshProfile must be a string")
    if profile:
        profile, profile_name = resolve_dsh_profile(profile, base, home or dsh_home(), path_map)
        patch = profile_patch_path(profile)
        if os.path.isfile(patch):
            with open(patch, encoding="utf-8-sig") as f:
                for p in parse_partitions(f.read(), log):
                    host_root = p["root"]
                    root = map_path(host_root, path_map)
                    if not root:
                        dropped.append({"name": p["name"], "path": None, "source": "profile", "reason": "no root"})
                        log(f"workspace {p['name']}: partition has no root; ignored")
                        continue
                    if not _is_abs(os.path.expanduser(root)):
                        dropped.append({"name": p["name"], "path": root, "source": "profile", "reason": "root not absolute"})
                        log(f"workspace {p['name']}: partition root is not absolute: {root}; ignored")
                        continue
                    candidates[p["name"]] = _local_path(root)
                    hosts[p["name"]] = host_root if root != host_root else candidates[p["name"]]
                    sources[p["name"]] = "profile"
        else:
            log(f"profile patch not found: {patch}; no partitions read")

    explicit = config.get("workspaces")
    if explicit is None:
        explicit = {}
    if not isinstance(explicit, dict):
        raise ConfigError(f"{path}: workspaces must be an object of name -> path")
    for name, value in explicit.items():
        if not isinstance(name, str) or not name.strip():
            log(f"{path}: empty workspace name ignored")
            continue
        if value is None:
            hosts.pop(name, None)
            if name in candidates:
                dropped.append({"name": name, "path": candidates.pop(name), "source": sources.pop(name), "reason": "hidden by workspaces.json"})
            continue
        if not isinstance(value, str) or not value.strip():
            log(f"workspace {name}: path must be a non-empty string; ignored")
            continue
        mapped = map_path(value, path_map)
        candidates[name] = _local_path(mapped, base)
        hosts[name] = value.strip() if mapped != value else candidates[name]
        sources[name] = "workspaces.json"

    workspaces = {}
    for name, p in candidates.items():
        if isdir(p):
            workspaces[name] = p
        else:
            dropped.append({"name": name, "path": p, "source": sources[name], "reason": "path does not exist"})
            log(f"workspace {name}: path does not exist: {p} (from {sources[name]}); not reported to the hub")
            sources.pop(name)
    cfg_node = config.get("node")
    file_node = cfg_node.strip() if isinstance(cfg_node, str) and cfg_node.strip() else None
    node = (node or file_node or "").strip() or default_node()
    hub = _opt_str(config, "hubUrl", path)
    token_file = _opt_str(config, "tokenFile", path)
    if token_file is not None:
        token_file = _local_path(token_file, base)
    has_runtime = "runtime" in config
    runtime = config.get("runtime")
    if runtime is not None and not isinstance(runtime, dict):
        raise ConfigError(f"{path}: runtime must be an object or null")
    proxy = config.get("proxy")
    if proxy is True or not (proxy is None or proxy is False or isinstance(proxy, str)):
        raise ConfigError(f"{path}: proxy must be a URL string, false (direct) or null")
    if isinstance(proxy, str):
        proxy = normalize_proxy(proxy) if proxy.strip() else None
    wm = WorkspaceMap(node, path, profile or None, workspaces, sources, dropped, hub, token_file, proxy,
                      file_node=file_node, legacy=legacy, exists=exists,
                      host_paths={n: hosts.get(n, p) for n, p in workspaces.items()},
                      runtime=runtime, has_runtime=has_runtime, machine=machine_settings(config, path, base))
    wm.profile_name = profile_name
    wm.agent_file = in_agents
    wm.path_map = path_map
    return wm


CAPABILITY_RE = re.compile(r"([a-z][a-z0-9-]{0,47})(?::([1-9][0-9]?))?")


def parse_capabilities(value, where="DSH_CAPABILITIES"):
    """Comma separated / list / {name: limit} -> ["browser:1", "test", ...] (name[:N], N 1..32 per capability)."""
    if value is None:
        return []
    if isinstance(value, dict):
        items = []
        for name, limit in value.items():
            if limit is None or limit is True:
                items.append(str(name))
            elif isinstance(limit, int) and not isinstance(limit, bool):
                items.append(f"{name}:{limit}")
            else:
                raise ConfigError(f"{where}: capability {name} must map to a number 1..32 or null")
    elif isinstance(value, str):
        items = value.split(",")
    elif isinstance(value, list):
        items = value
    else:
        raise ConfigError(f"{where}: capabilities must be a list, an object or a comma separated string")
    out, seen = [], set()
    for item in items:
        item = item.strip() if isinstance(item, str) else item
        if item == "":
            continue
        m = CAPABILITY_RE.fullmatch(item) if isinstance(item, str) else None
        if m is None or (m.group(2) is not None and int(m.group(2)) > 32):
            raise ConfigError(f"{where}: bad capability {item!r}: lowercase name, optionally name:N with N 1..32")
        if m.group(1) not in seen:
            seen.add(m.group(1))
            out.append(item)
    if len(out) > 32:
        raise ConfigError(f"{where}: at most 32 capabilities")
    return out


def machine_settings(config, path, base=None):
    """Agent config keys that describe this worker (each machine keeps its own file)."""
    out = {}
    if "capabilities" in config and config["capabilities"] is not None:
        out["capabilities"] = parse_capabilities(config["capabilities"], f"{path}: capabilities")
    exchange = _opt_str(config, "exchange", path)
    out["exchange"] = _local_path(exchange, base) if exchange is not None and base is not None else exchange
    for key in ("maxConcurrency", "pullEverySeconds", "heartbeatSeconds"):
        v = config.get(key)
        if v is not None and (isinstance(v, bool) or not isinstance(v, int)):
            raise ConfigError(f"{path}: {key} must be a whole number")
        out[key] = v
    for key in ("role", "platform", "agentId"):
        out[key] = _opt_str(config, key, path)
    return out


def check_runtime(rt, where="runtime"):
    """Light local check (the hub validates fully): lists of known values, effort objects."""
    if rt is None:
        return None
    if not isinstance(rt, dict):
        raise ConfigError(f"{where} must be an object")
    for key, allowed in (("modes", EFFORT_MODES), ("thinking", EFFORT_THINKING)):
        v = rt.get(key, [])
        if not isinstance(v, list) or any(x not in allowed for x in v):
            raise ConfigError(f"{where}.{key} must be a list of {', '.join(allowed)}")
    agents = rt.get("agents", [])
    if not isinstance(agents, list) or any(not (isinstance(a, str) or (isinstance(a, dict) and isinstance(a.get("name"), str))) for a in agents):
        raise ConfigError(f"{where}.agents must be a list of names or {{name, description}}")
    defaults = rt.get("defaults")
    defaults = {} if defaults is None else defaults
    if not isinstance(defaults, dict):
        raise ConfigError(f"{where}.defaults must be an object of task type -> effort")
    for label, e in [("default", rt.get("default"))] + [(f"defaults.{k}", v) for k, v in defaults.items()]:
        if e is None:
            continue
        if not isinstance(e, dict) or e.get("mode", "fast") not in EFFORT_MODES or e.get("thinking", "off") not in EFFORT_THINKING:
            raise ConfigError(f"{where}.{label} must be {{mode, thinking, agent}} with known values")
    return rt


def platform_runtime(platform):
    rt = PLATFORM_RUNTIMES.get(platform)
    return json.loads(json.dumps(rt)) if rt is not None else None


def resolve_effort(task, runtime):
    """The effort this task runs with: the task's own (top level, or context.effort from an older
    hub), else the runtime default for its type, else the runtime default. Adds `source`."""
    own = task.get("effort")
    if not isinstance(own, dict):
        ctx = task.get("context")
        own = ctx.get("effort") if isinstance(ctx, dict) and isinstance(ctx.get("effort"), dict) else None
    rt = runtime or {}
    base = (rt.get("defaults") or {}).get(task.get("type")) or rt.get("default") or {}
    keep = ("mode", "thinking", "agent")
    if own:
        out = {k: v for k, v in base.items() if k in keep}
        if "mode" in own and own["mode"] != base.get("mode"):
            out.pop("thinking", None)  # another mode does not inherit the default's thinking
        out.update({k: v for k, v in own.items() if k in keep})
        out["source"] = "task"
        return out
    if base:
        return dict({k: v for k, v in base.items() if k in keep}, source="default")
    return {"source": "none"}


def parse_proxy_choice(value):
    """DSH_HUB_PROXY value -> (proxy URL or None, direct?). off = direct, env = urllib's env / system proxy."""
    v = (value or "").strip()
    if v.lower() in PROXY_OFF:
        return None, True
    if v.lower() in PROXY_ENV:
        return None, False
    return normalize_proxy(v), False


def _int_setting(value, key, lo, hi):
    try:
        n = int(str(value).strip())
    except ValueError:
        raise ConfigError(f"{key} must be an integer {lo}..{hi}") from None
    if not lo <= n <= hi:
        raise ConfigError(f"{key} must be an integer {lo}..{hi}")
    return n


def resolve_settings(wm, url=None, token_file=None, proxy=None, no_proxy=False, env=None, dotenv=None, worker_dir=None, cli=None,
                     agent=None):
    """All settings. Order: command line > process env > worker/.env > agent config (agents/<id>.json, or a
    legacy profile.json) > default. `agent` is the selected agent id (select_agent); with it the token,
    exchange and log default to tokens/<id>.token, exchange/<id>/ and logs/<id>.log.

    Returns a dict with url, proxy, no_proxy, cafile, agent_id, node, platform, capabilities,
    max_concurrency, token_file, exchange, heartbeat_seconds, worker_dir and `sources`
    (key -> "cli" | "env" | ".env" | "profile" | "default"). url may be None."""
    env = os.environ if env is None else env
    dotenv = dotenv or {}
    cli = dict(cli or {})
    wd = worker_dir or default_worker_dir(env)
    sources = {}
    file_label = "agent" if getattr(wm, "agent_file", False) else "profile"
    layout = agent_paths(wd, agent) if agent else None

    def pick(key, name, cli_value, profile_value=None, default=None):
        if cli_value not in (None, ""):
            sources[key] = "cli"
            return cli_value
        for label, table in (("env", env), (".env", dotenv)):
            v = table.get(name)
            if isinstance(v, str) and v.strip() != "":
                sources[key] = label
                return v.strip()
        if profile_value is not None:
            sources[key] = file_label
            return profile_value
        sources[key] = "default"
        return default

    def in_wd(value, key):
        if value is None:
            return None
        if sources[key] == "cli":
            return os.path.abspath(os.path.expanduser(value))
        if sources[key] in ("profile", "agent"):
            return value  # already resolved against the file's folder
        return _local_path(value, wd)

    st = {"worker_dir": wd, "sources": sources}
    st["url"] = pick("url", "DSH_HUB_URL", url, wm.hub_url)
    # proxy: --no-proxy / --proxy, then DSH_HUB_PROXY, then profile proxy, default env
    if no_proxy:
        sources["proxy"] = "cli"
        st["proxy"], st["no_proxy"] = None, True
    else:
        raw = pick("proxy", "DSH_HUB_PROXY", proxy)
        if sources["proxy"] == "default":
            if wm.proxy is False:
                sources["proxy"] = file_label
                st["proxy"], st["no_proxy"] = None, True
            elif wm.proxy:
                sources["proxy"] = file_label
                st["proxy"], st["no_proxy"] = wm.proxy, False
            else:
                st["proxy"], st["no_proxy"] = None, False
        else:
            try:
                st["proxy"], st["no_proxy"] = parse_proxy_choice(raw)
            except ConfigError:
                raise ConfigError(f"DSH_HUB_PROXY / --proxy must be http://host:port, off or env (from {sources['proxy']})") from None
    st["cafile"] = in_wd(pick("cafile", "DSH_HUB_CAFILE", cli.get("cafile")), "cafile")
    file_id = (getattr(wm, "machine", {}) or {}).get("agentId")
    if agent and file_id and file_id != agent:
        raise ConfigError(f"{wm.config_path}: agentId {file_id!r} does not match the file name {agent!r}")
    agent_id = pick("agent_id", "DSH_AGENT_ID", cli.get("agent_id"), agent or file_id)
    if agent_id is not None and not AGENT_ID_RE.fullmatch(agent_id):
        raise ConfigError(f"DSH_AGENT_ID / --agent-id must match ^[a-z][a-z0-9-]{{1,47}}$ (from {sources['agent_id']})")
    if agent and agent_id != agent:
        raise ConfigError(f"DSH_AGENT_ID={agent_id} (from {sources['agent_id']}) is not the selected agent {agent}; "
                          "remove DSH_AGENT_ID (the agent's name is its agents/<id>.json file name)")
    st["agent_id"] = agent_id
    st["agent"] = agent
    st["dsh_profile"] = getattr(wm, "profile_name", None)
    st["log_file"] = layout["log"] if layout else os.path.join(wd, "run.log")
    st["node"] = pick("node", "DSH_NODE", cli.get("node"), wm.file_node, default_node())
    m = getattr(wm, "machine", {}) or {}
    st["platform"] = pick("platform", "DSH_PLATFORM", cli.get("platform"), m.get("platform"), "custom")
    caps = pick("capabilities", "DSH_CAPABILITIES", cli.get("capabilities"), m.get("capabilities"), "")
    st["capabilities"] = parse_capabilities(caps, f"capabilities (from {sources['capabilities']})")
    st["max_concurrency"] = _int_setting(pick("max_concurrency", "DSH_MAX_CONCURRENCY", cli.get("max_concurrency"),
                                              m.get("maxConcurrency"), 1),
                                         "DSH_MAX_CONCURRENCY", 1, 32)
    st["token_file"] = in_wd(pick("token_file", "DSH_AGENT_TOKEN_FILE", token_file, wm.token_file,
                                  layout["token"] if layout else "agent.token"), "token_file")
    st["exchange"] = in_wd(pick("exchange", "DSH_EXCHANGE", cli.get("exchange"), m.get("exchange"),
                                layout["exchange"] if layout else "exchange"), "exchange")
    st["runtime"] = check_runtime(wm.runtime, f"{wm.config_path}: runtime") if wm.has_runtime else platform_runtime(st["platform"])
    st["heartbeat_seconds"] = _int_setting(pick("heartbeat_seconds", "DSH_HEARTBEAT_SECONDS", cli.get("heartbeat_seconds"), m.get("heartbeatSeconds"),
                                                DEFAULT_HEARTBEAT), "DSH_HEARTBEAT_SECONDS", 5, 3600)
    role = pick("role", "DSH_ROLE", cli.get("role"), m.get("role"), "worker")
    if role not in ROLES:
        raise ConfigError(f"DSH_ROLE / --role must be one of {', '.join(ROLES)} (from {sources['role']})")
    st["role"] = role
    every = pick("pull_every_seconds", "DSH_PULL_EVERY_SECONDS", cli.get("pull_every_seconds"), m.get("pullEverySeconds"), None)
    st["pull_every_seconds"] = None if every is None else _int_setting(every, "DSH_PULL_EVERY_SECONDS", 60, 86400)
    return st


def settings_summary(st):
    """Printable settings: proxy credentials masked, the token itself is never part of it."""
    if st["no_proxy"]:
        proxy = "off"
    elif st["proxy"]:
        proxy = mask_url(st["proxy"])
    else:
        proxy = "env"
    return {"hub_url": st["url"], "proxy": proxy, "cafile": st["cafile"], "agent_id": st["agent_id"], "node": st["node"],
            "platform": st["platform"], "capabilities": st["capabilities"], "max_concurrency": st["max_concurrency"],
            "token_file": st["token_file"], "token_file_exists": bool(st["token_file"]) and os.path.isfile(st["token_file"]),
            "exchange": st["exchange"], "heartbeat_seconds": st["heartbeat_seconds"],
            "role": st.get("role"), "pull_every_seconds": st.get("pull_every_seconds"),
            "dsh_profile": st.get("dsh_profile"), "log_file": st.get("log_file"),
            "runtime": st.get("runtime")}


# --- exchange folder bridge ---------------------------------------------------------

def file_entry(path, description=""):
    with open(path, "rb") as f:
        data = f.read()
    return {"name": os.path.basename(path), "base64": base64.b64encode(data).decode("ascii"),
            "type": os.path.splitext(path)[1].lstrip("."), "description": description}


def write_atomic(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def write_exclusive(path, text):
    """Create `path` with O_CREAT | O_EXCL; raises FileExistsError if it already exists."""
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    except Exception:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise


def claim_task(exchange_root, task_id, by="worker", nonce=None, effort=None, now=None):
    """Atomically claim `inbox/<task_id>` -> `working/<task_id>` and create `claim.json` with O_EXCL.

    Kernel-level mutual exclusion: `os.rename` of `inbox/<task_id>` to `working/<task_id>`
    succeeds for at most one concurrent caller; all losers get `claimed=False` without
    touching `working/` or `outbox/`.
    """
    if not isinstance(task_id, str) or not TASK_ID_RE.fullmatch(task_id) or task_id in (".", ".."):
        raise ConfigError(f"invalid task_id: {task_id!r}")
    root = os.path.abspath(exchange_root)
    for box in ("working", "outbox", "failed", "archive"):
        if os.path.exists(os.path.join(root, box, task_id)):
            return {"claimed": False, "task_id": task_id, "reason": f"already in {box}"}
    inbox_dir = os.path.join(root, "inbox", task_id)
    working_dir = os.path.join(root, "working", task_id)
    if not os.path.isdir(inbox_dir):
        return {"claimed": False, "task_id": task_id, "reason": "not in inbox"}
    try:
        os.rename(inbox_dir, working_dir)
    except OSError as e:
        return {"claimed": False, "task_id": task_id, "reason": f"claim race lost ({type(e).__name__}: {e})"}
    task_file = os.path.join(working_dir, "task.json")
    try:
        with open(task_file, encoding="utf-8-sig") as f:
            task = json.load(f)
    except (OSError, ValueError) as e:
        return {"claimed": False, "task_id": task_id, "reason": f"bad task.json: {e}"}
    eff = effort if effort is not None else task.get("effort_resolved")
    claim_doc = {
        "by": by,
        "nonce": nonce,
        "at": now or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "effort": eff,
    }
    claim_path = os.path.join(working_dir, "claim.json")
    try:
        write_exclusive(claim_path, json.dumps(claim_doc, ensure_ascii=False, indent=2) + "\n")
    except FileExistsError:
        return {"claimed": False, "task_id": task_id, "reason": "claim.json already exists"}
    return {"claimed": True, "task_id": task_id, "working_dir": working_dir, "claim": claim_doc, "task": task}


EXCHANGE_README = """\
# dsh 交换目录（worker 本机）

这个目录由 `agent_client.py`（`init` / `run` / `bridge`）创建，位置由 worker/.env 里的 `DSH_EXCHANGE` 决定。

**刚建好时是空的，这是正常的。** 任务要满足下面三条才会出现在 `inbox/`：

1. `python agent_client.py register` 已被 DSH 批准（DSH 对话里 `agent_requests` -> `agent_approve`），令牌已写进 `agent.token`；
2. `python agent_client.py run` 正在运行（或定时执行 `bridge --once`）；
3. DSH 用 `task_dispatch` 给这个 worker（或它能接的 `pool:<capability>`）派了任务。

`python agent_client.py status` 可以看到 hub 眼里的本机状态（在线、持有的任务）。

| 子目录 | 谁写 | 内容 |
|---|---|---|
| `inbox/<task_id>/` | agent_client | `task.json` + 输入文件 |
| `working/<task_id>/` | agent | 开始做时把任务目录挪到这里（可选） |
| `outbox/<task_id>/` | agent | 产出文件（`changes.patch`、`summary.md` 等），**最后**写 `result.json` |
| `failed/<task_id>/` | agent | 失败时写 `result.json`（同样最后写） |
| `archive/<task_id>/` | agent_client | 上传完成或任务被取消后归档 |

**进度和会话（可选，推荐）**：做任务时往任务目录里追加 JSON 行，agent_client 每轮把新行发到云端，断网时留在文件里，恢复后补发：

- `progress.jsonl`：`{"stage": "started|step|blocked|needs_input|uploading", "message": "...", "progress": 0.4}`
- `session.jsonl`：`{"role": "user|assistant|tool|system|note", "text": "...", "name": "bash"}`

写结果时把这两个文件也拷进 `outbox/`（或 `failed/`）的结果目录，再最后写 `result.json`。它们不会作为结果文件上传。

**职责边界（先读）**：`task.json` 里的 `boundary` 一句话写明本机 worker 能做什么、不能做什么，`duties` 是同样内容的列表（`role`、`can`、`cannot`、`handoff`）。
按它做，不要越界：

- `coder`（如 AWS Quick）：只改代码，交 `changes.patch` 和 `summary.md`（写清改了哪些文件）。**不跑测试、不执行命令、不碰 git**，也不要"顺手验证一下"。跑测试和提交由 DSH 另派给 worker。
- 任务里有越界的部分：只做能做的，越界部分不做；全都越界就不做。在 `result.json` 里写 `"needs_input": "越界：<哪一步>，请改派给 worker"`，调度方会拆开改派。
- `worker`：什么都能做；有 coder 在线时，DSH 会先把改代码派给 coder，再把测试和 git 派给你，上游的 `changes.patch` 会出现在输入文件里。

协议：docs/DSH-HUB-PROTOCOL-v2.md；配置：plugins/dsh-agent-hub/README.md。
"""


def ensure_exchange(root):
    """Create the exchange folder, its sub folders and README.md (never overwritten). Returns what was created."""
    created = []
    for d in EXCHANGE_DIRS:
        p = os.path.join(root, d)
        if not os.path.isdir(p):
            os.makedirs(p, exist_ok=True)
            created.append(d)
    readme = os.path.join(root, "README.md")
    if not os.path.exists(readme):
        write_atomic(readme, EXCHANGE_README)
        created.append("README.md")
    else:
        # Our own README from an older client (it lacks the role section): bring it up to date.
        # A README someone wrote by hand (other first line) is left alone.
        try:
            with open(readme, encoding="utf-8") as fh:
                old = fh.read()
        except OSError:
            old = None
        if old is not None and old != EXCHANGE_README and old.startswith("# dsh 交换目录") and "职责边界" not in old:
            write_atomic(readme, EXCHANGE_README)
            created.append("README.md (updated)")
    return created


def _upload_order(name):
    return ({"changes.patch": 0, "summary.md": 1}.get(name, 2), name)


# --- live progress and the session log --------------------------------------------
#
# While it works, the agent may append JSON lines to two files in its task folder
# (working/<id>/, and a copy in the result folder before result.json):
#   progress.jsonl  {"stage": "started|step|blocked|needs_input|uploading", "message": "...", "progress": 0.4}
#   session.jsonl   {"role": "user|assistant|tool|system|note", "text": "...", "name": "bash", "at": "..."}
# The bridge sends new lines every cycle (progress -> /v1/event, session -> /v1/session). How
# many lines of each went out is kept in <exchange>/.sync/<id>.json, so nothing is sent twice and
# whatever was written while the hub was out of reach goes out once it is back (the files are
# the offline spool). Both files stay local: they are not uploaded as result files.

PROGRESS_FILE, SESSION_FILE, SYNC_DIR = "progress.jsonl", "session.jsonl", ".sync"
LOCAL_ONLY_FILES = (PROGRESS_FILE, SESSION_FILE)
STAGES = ("received", "started", "step", "blocked", "needs_input", "uploading")
SESSION_ROLES = ("user", "assistant", "tool", "system", "note")
SESSION_BATCH = 200
SESSION_TEXT_MAX = 20000


def read_new_lines(path, skip):
    """(parsed JSON objects after the first `skip` complete lines, complete line count). A last line
    without its newline is still being written and is left for the next cycle; bad lines count but
    are dropped."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return [], skip
    lines = data.split(b"\n")
    complete = lines[:-1]  # the part after the last newline is unfinished (or empty)
    out = []
    for raw in complete[skip:]:
        raw = raw.strip()
        if not raw:
            continue
        try:
            item = json.loads(raw.decode("utf-8-sig", errors="replace"))
        except ValueError:
            continue
        if isinstance(item, dict):
            out.append(item)
    return out, max(skip, len(complete))


def progress_updates(items):
    """progress.jsonl lines -> the events to send. A run of `step` lines is sent as its last one."""
    out = []
    for it in items:
        stage = it.get("stage") if it.get("stage") in STAGES else ("step" if it.get("stage") is not None else None)
        msg = it.get("message")
        upd = {"stage": stage, "message": msg[:1000] if isinstance(msg, str) else None,
               "progress": it.get("progress") if isinstance(it.get("progress"), (int, float)) and 0 <= it.get("progress") <= 1 else None}
        if upd["stage"] is None and upd["message"] is None and upd["progress"] is None:
            continue
        if out and upd["stage"] in ("step", None) and out[-1]["stage"] in ("step", None):
            out[-1] = upd
        else:
            out.append(upd)
    return out


def session_entry(it):
    role = it.get("role") if it.get("role") in SESSION_ROLES else "note"
    text = it.get("text")
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False) if text is not None else ""
    e = {"role": role, "text": text[:SESSION_TEXT_MAX]}
    if isinstance(it.get("name"), str) and it["name"].strip():
        e["name"] = it["name"].strip()[:64]
    if isinstance(it.get("at"), (str, int, float)):
        e["at"] = it["at"]
    if it.get("error") is True:
        e["error"] = True
    return e


class Bridge:
    def __init__(self, client, root, max_tasks=1, log=print, workspaces=None, node=None, wait=DEFAULT_WAIT, host_paths=None):
        self.c, self.root, self.max, self.log = client, root, max_tasks, log
        self.workspaces = dict(workspaces or {})
        self.host_paths = dict(host_paths or {})
        self.node = node
        self.wait = wait
        self.rejected = 0
        self.aborted = 0
        self.full = False
        ensure_exchange(root)

    def live_workspaces(self):
        return sorted(n for n, p in self.workspaces.items() if os.path.isdir(p))

    def workspace_path(self, name):
        p = self.workspaces.get(name)
        return p if p and os.path.isdir(p) else None

    def running_ids(self):
        """Tasks this machine still holds: in inbox / working / outbox / failed, not marked aborted."""
        ids = set()
        for box in ("inbox", "working", "outbox", "failed"):
            base = os.path.join(self.root, box)
            for name in os.listdir(base):
                if name.startswith(".") or not TASK_ID_RE.fullmatch(name) or not os.path.isdir(os.path.join(base, name)):
                    continue
                if os.path.exists(os.path.join(base, name, ABORT_MARK)):
                    continue
                ids.add(name)
        return sorted(ids)

    def heartbeat(self, status):
        res = self.c.heartbeat(status, self.live_workspaces(), running=self.running_ids())
        if isinstance(res, dict) and res.get("abort"):
            self.abort(res["abort"])
        return res

    def abort(self, task_ids):
        """The hub no longer gives us these tasks (cancelled, requeued, reassigned): stop delivering them."""
        note = {"aborted_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "reason": "the hub no longer assigns this task to this worker (cancelled, requeued or reassigned); stop working on it"}
        done = []
        for tid in task_ids:
            if not isinstance(tid, str) or not TASK_ID_RE.fullmatch(tid) or tid in (".", ".."):
                continue
            for box in ("inbox", "outbox", "failed"):
                d = os.path.join(self.root, box, tid)
                if os.path.isdir(d):
                    dest = os.path.join(self.root, "archive", tid)
                    if os.path.exists(dest):
                        shutil.rmtree(dest)
                    shutil.move(d, dest)
                    write_atomic(os.path.join(dest, ABORT_MARK), json.dumps(dict(note, task_id=tid, was_in=box)))
                    done.append(tid)
            w = os.path.join(self.root, "working", tid)
            if os.path.isdir(w):
                write_atomic(os.path.join(w, ABORT_MARK), json.dumps(dict(note, task_id=tid, was_in="working")))
                done.append(tid)
        if done:
            self.log(f"aborted by the hub: {', '.join(sorted(set(done)))}")
            self.aborted += len(set(done))
        return sorted(set(done))

    def _live(self, box, name):
        d = os.path.join(self.root, box, name)
        return (not name.startswith(".") and os.path.isdir(d)
                and not os.path.exists(os.path.join(d, ABORT_MARK)))

    def _busy(self):
        """Tasks taking a slot: unique task ids in inbox / working and not aborted (an aborted
        copy left in working/ must not stop this worker from ever pulling again)."""
        ids = {name for box in ("inbox", "working")
               for name in os.listdir(os.path.join(self.root, box)) if self._live(box, name)}
        return len(ids)

    def _known(self, task_id):
        """Already held here. Only archive/ (done or aborted earlier) does not count: the hub leasing
        the same id again means it wants it worked on again. An aborted copy still in working/ that
        the hub hands back is un-aborted: its executor may still be on it."""
        w = os.path.join(self.root, "working", task_id)
        mark = os.path.join(w, ABORT_MARK)
        if os.path.isdir(w) and os.path.exists(mark):
            os.remove(mark)
            self.log(f"{task_id}: the hub gave it back; no longer marked aborted")
            return True
        if any(os.path.exists(os.path.join(self.root, d, task_id)) for d in ("inbox", "working", "outbox", "failed")):
            return True
        stale = os.path.join(self.root, "archive", task_id)
        if os.path.exists(stale):  # keep the earlier copy, deliver this one fresh
            os.replace(stale, f"{stale}.prev-{int(time.time())}")
        return False

    def _reject_missing(self, task):
        tid, ws = task["task_id"], task.get("workspace")
        message = f"workspace {ws!r} is not mapped on node {self.node or '?'} ({getattr(self.c, 'agent_id', '?')})"
        try:
            self.c.result(tid, "failed", message, [], {"code": WORKSPACE_MISSING, "message": message, "retryable": False})
            self.log(f"refused {tid}: {message}")
        except HubError as e:
            if e.status not in (404, 409):
                raise
            self.log(f"hub refused WORKSPACE_MISSING for {tid} ({e.code})")
        self.rejected += 1

    def pull(self):
        room = max(0, self.max - self._busy())
        self.full = room == 0
        if room == 0:
            self.heartbeat("busy")
            return 0
        delivered = 0
        for t in self.c.poll(room, self.wait):
            tid = t["task_id"]
            if self._known(tid):
                continue
            ws = t.get("workspace")
            ws_path = None
            if ws:
                ws_path = self.workspace_path(ws)
                if ws_path is None:
                    self._reject_missing(t)
                    continue
            stage = os.path.join(self.root, "inbox", f".{tid}.part")
            os.makedirs(stage, exist_ok=True)
            for item in t.get("inputs", []):
                data = self.c.artifact(tid, item["name"], item.get("from_task"))
                with open(os.path.join(stage, item["name"]), "wb") as f:
                    f.write(data)
            t["workspace_path"] = ws_path
            t["workspace_host_path"] = self.host_paths.get(ws, ws_path) if ws_path else None
            t["effort_resolved"] = resolve_effort(t, getattr(self.c, "runtime", None))
            t["node"] = self.node
            t["exchange"] = {"result_dir": f"outbox/{tid}", "failed_dir": f"failed/{tid}",
                             "outputs": "changes.patch, summary.md and any other files; write result.json LAST"}
            write_atomic(os.path.join(stage, "task.json"), json.dumps(t, ensure_ascii=False, indent=2))
            os.replace(stage, os.path.join(self.root, "inbox", tid))
            self.c.progress(tid, 0.0, "delivered to exchange inbox", stage="received")
            self.log(f"pulled {tid}: {t.get('title')}" + (f" [{ws}]" if ws else "") + (f" <{t['capability']}>" if t.get("capability") else ""))
            delivered += 1
        return delivered

    def _outputs(self, d):
        files = []
        for n in sorted(os.listdir(d), key=_upload_order):
            p = os.path.join(d, n)
            if n == "result.json" or n in LOCAL_ONLY_FILES or n.endswith(".tmp") or n.startswith("."):
                continue
            if not os.path.isfile(p):
                self.log(f"{d}: sub-folder {n} not uploaded (only top-level files are)")
                continue
            if not FILE_NAME_RE.fullmatch(n) or ".." in n:
                self.log(f"{d}: file name {n!r} is not accepted by the hub; skipped")
                continue
            files.append(p)
        if len(files) > MAX_RESULT_FILES:
            self.log(f"{d}: {len(files)} files, the hub takes {MAX_RESULT_FILES}; extra files skipped")
            files = files[:MAX_RESULT_FILES]
        return files

    def push(self):
        sent = 0
        for box in ("outbox", "failed"):
            base = os.path.join(self.root, box)
            for tid in sorted(os.listdir(base)):
                d = os.path.join(base, tid)
                rp = os.path.join(d, "result.json")
                if tid.startswith(".") or not os.path.isfile(rp):
                    continue
                try:
                    with open(rp, encoding="utf-8-sig") as f:
                        r = json.load(f)
                except ValueError:
                    self.log(f"{tid}: result.json is not complete JSON yet; retrying next tick")
                    continue
                status = r.get("status") or ("failed" if box == "failed" else "completed")
                paths = self._outputs(d)
                summary = r.get("summary") or ""
                sm = os.path.join(d, "summary.md")
                if not summary and os.path.isfile(sm):
                    with open(sm, encoding="utf-8", errors="replace") as f:
                        summary = f.read(SUMMARY_MAX)
                files = [file_entry(p) for p in paths]
                self.sync(tid, d)  # the last progress lines and the session go out before the result
                try:
                    self.c.result(tid, status, summary, files, r.get("error"), r.get("needs_input"))
                    self.log(f"uploaded {tid}: {status} ({len(files)} file(s))")
                except HubError as e:
                    if e.status not in (404, 409):
                        raise
                    self.log(f"hub refused {tid} ({e.code}); archiving locally")
                dest = os.path.join(self.root, "archive", tid)
                if os.path.exists(dest):
                    shutil.rmtree(dest)
                shutil.move(d, dest)
                for leftover in ("inbox", "working"):
                    p = os.path.join(self.root, leftover, tid)
                    if os.path.exists(p):
                        shutil.rmtree(p, ignore_errors=True)
                self._drop_sync(tid)
                sent += 1
        return sent

    # --- progress.jsonl / session.jsonl -> hub ---------------------------------
    def _sync_path(self, tid):
        return os.path.join(self.root, SYNC_DIR, f"{tid}.json")

    def _load_sync(self, tid):
        try:
            with open(self._sync_path(tid), encoding="utf-8") as f:
                st = json.load(f)
            return {"progress": int(st.get("progress", 0)), "session": int(st.get("session", 0)), "gone": bool(st.get("gone"))}
        except (OSError, ValueError, TypeError):
            return {"progress": 0, "session": 0, "gone": False}

    def _save_sync(self, tid, st):
        os.makedirs(os.path.join(self.root, SYNC_DIR), exist_ok=True)
        write_atomic(self._sync_path(tid), json.dumps(st))

    def _drop_sync(self, tid):
        try:
            os.remove(self._sync_path(tid))
        except OSError:
            pass

    def sync(self, tid, d):
        """Send the new lines of <d>/progress.jsonl and <d>/session.jsonl. True when anything went out.
        A network error propagates (the lines stay unsent and go out next time); a 404/409 from the
        hub (task gone or not ours) stops syncing this task."""
        if not TASK_ID_RE.fullmatch(tid):
            return False
        st = self._load_sync(tid)
        if st["gone"]:
            return False
        sent = False
        try:
            items, n = read_new_lines(os.path.join(d, PROGRESS_FILE), st["progress"])
            for upd in progress_updates(items):
                self.c.progress(tid, upd["progress"], upd["message"], stage=upd["stage"])
                sent = True
            if n != st["progress"]:
                st["progress"] = n
                self._save_sync(tid, st)
            items, n = read_new_lines(os.path.join(d, SESSION_FILE), st["session"])
            entries = [session_entry(it) for it in items]
            for i in range(0, len(entries), SESSION_BATCH):
                self.c.session(tid, entries[i:i + SESSION_BATCH])
                sent = True
            if n != st["session"]:
                st["session"] = n
                self._save_sync(tid, st)
        except HubError as e:
            if e.status not in (404, 409):
                raise
            self.log(f"{tid}: hub no longer takes its progress / session ({e.code})")
            st["gone"] = True
            self._save_sync(tid, st)
        return sent

    def renew(self):
        """Every cycle, for each task being worked on: send its new progress / session lines; with
        nothing new only renew the lease (silent on the hub)."""
        base = os.path.join(self.root, "working")
        for tid in os.listdir(base):
            d = os.path.join(base, tid)
            if tid.startswith(".") or not os.path.isdir(d) or os.path.exists(os.path.join(d, ABORT_MARK)):
                continue
            try:
                if not self.sync(tid, d):
                    self.c.progress(tid, renew=True)
            except HubError as e:
                if e.status in (404, 409):
                    self.log(f"{tid} no longer leased ({e.code})")
                else:
                    raise

    def tick(self):
        self.heartbeat("idle")
        pushed = self.push()
        self.renew()
        pulled = self.pull()
        return pulled, pushed


class Runner:
    """`run`: stay online. First heartbeat with back-off (5 s doubling to 60 s), then a heartbeat
    every `heartbeat_seconds` and long polls in between (each poll is cut to the next heartbeat).
    Network / 5xx / transient 403 ip-not-allowed errors back off the same way; 401 and other
    403 errors (token revoked / role forbidden) stop the loop."""

    def __init__(self, bridge, heartbeat_seconds=DEFAULT_HEARTBEAT, wait=DEFAULT_WAIT, log=print,
                 sleep=time.sleep, clock=time.monotonic):
        self.b, self.every, self.wait, self.log, self.sleep, self.clock = bridge, heartbeat_seconds, wait, log, sleep, clock
        self.next_heartbeat = 0.0
        self.backoff = 5
        self.heartbeats = 0

    @staticmethod
    def fatal(err):
        if not isinstance(err, HubError):
            return False
        if err.status == 401:
            return True
        if err.status == 403:
            # Proxy exit IP drift produces 403 ip-not-allowed; keep backing off until the allowlisted IP returns.
            return err.code != "ip-not-allowed"
        return False

    def _fail(self, err):
        self.log(f"hub not reachable ({err}); retrying in {self.backoff} s")
        self.sleep(self.backoff)
        self.backoff = min(60, self.backoff * 2)

    def start(self):
        while True:
            try:
                self.b.heartbeat("idle")
                self.heartbeats += 1
                self.next_heartbeat = self.clock() + self.every
                self.backoff = 5
                return
            except (HubError, OSError) as err:
                if self.fatal(err):
                    raise
                self._fail(err)

    def cycle(self):
        now = self.clock()
        if now >= self.next_heartbeat:
            self.b.heartbeat("busy" if self.b.full else "idle")
            self.heartbeats += 1
            self.next_heartbeat = now + self.every
        self.b.push()
        self.b.renew()
        left = max(0.0, self.next_heartbeat - self.clock())
        self.b.wait = int(max(0, min(self.wait, left)))
        pulled = self.b.pull()
        if pulled == 0 and (self.b.full or self.b.wait < 1):
            self.sleep(max(1.0, min(5.0, left)))  # nothing to wait on at the hub: do not spin
        return pulled

    def run(self, cycles=None):
        self.start()
        done = 0
        while cycles is None or done < cycles:
            try:
                self.cycle()
                self.backoff = 5
            except (HubError, OSError) as err:
                if self.fatal(err):
                    raise
                self._fail(err)
            done += 1
        return done


# --- CLI ------------------------------------------------------------------------------

def config_help():
    """The configuration section of the module docstring (shown by --help)."""
    doc = __doc__ or ""
    start, end = doc.find("--- configuration ---"), doc.find("--- end ---")
    return doc[start:end].rstrip() if start >= 0 and end > start else None


def _add_local_args(s):
    s.add_argument("--worker-dir", help="worker folder with .env and agents/ (default <DSH home>/worker, DSH home = $DSH_HOME or ~/.dsh)")
    s.add_argument("--agent", help="which agents/<id>.json to use; overrides DSH_AGENT (one file = picked automatically)")
    s.add_argument("--profile-file", "--workspaces-file", dest="profile_file",
                   help=f"profile.json (or legacy workspaces.json, e.g. {DEFAULT_WORKSPACES_FILE}) to read instead of the worker dir's")
    s.add_argument("--node", help="node name; overrides DSH_NODE and \"node\" in profile.json (default: host name)")


def _add_net_args(s, worker=True):
    s.add_argument("--url", help="hub host or URL; overrides DSH_HUB_URL and \"hubUrl\" (normalized to https://<host>:7891/v1)")
    if worker:
        s.add_argument("--agent-id", help="worker id, e.g. quick-mydesk; overrides DSH_AGENT_ID")
        s.add_argument("--token-file", help="token file; overrides DSH_AGENT_TOKEN_FILE. The token is read only from this file")
    s.add_argument("--cafile", help="CA bundle for a hub with a private certificate; overrides DSH_HUB_CAFILE")
    s.add_argument("--insecure", action="store_true", help="skip TLS verification (self-signed lab only)")
    s.add_argument("--timeout", type=int, default=60, help="seconds per request (poll adds its wait on top)")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--proxy", help="HTTP proxy for the hub, e.g. http://127.0.0.1:7890, or off / env; overrides DSH_HUB_PROXY")
    g.add_argument("--no-proxy", action="store_true", help="connect directly (same as DSH_HUB_PROXY=off)")


def _client(st, token, workspaces, a, agent_id=None):
    url = hub_url(st["url"])
    note = proxy_notice(url, st["proxy"], st["no_proxy"])
    if note:
        warn(note)
    u = urllib.parse.urlsplit(url)
    if u.scheme == "http" and u.hostname not in LOOPBACK_HOSTS:
        warn("plain http to a non-loopback hub: the token would cross the network in clear text")
    return HubClient(url, token, a.insecure, st["cafile"], a.timeout, agent_id=agent_id or st["agent_id"] or None,
                     proxy=st["proxy"], no_proxy=st["no_proxy"], workspaces=workspaces, runtime=st.get("runtime"),
                     role=st.get("role"), pull_every_seconds=st.get("pull_every_seconds"), dsh_profile=st.get("dsh_profile"))


def check_settings(st):
    """Every network command needs a hub address (the token file always has a default)."""
    if not st["url"]:
        raise ConfigError("no hub address: set DSH_HUB_URL in worker/.env (or the environment), pass --url, "
                          "or set \"hubUrl\" in profile.json")


def read_token(path):
    with open(path, encoding="utf-8-sig") as f:
        token = f.read().strip()
    if not token:
        raise ConfigError(f"token file is empty: {path}")
    return token


# --- check: connectivity report ----------------------------------------------------------

LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def _with_scheme(proxy):
    return proxy if "://" in proxy else "http://" + proxy


def effective_proxy(url, proxy=None, no_proxy=False, env_proxies=None, bypass=None):
    """(proxy URL or None, where that choice comes from) for a request to `url`.

    Same rules urllib applies: an explicit proxy wins, no_proxy means direct, else
    HTTPS_PROXY / HTTP_PROXY / the system proxy unless NO_PROXY / the bypass list matches."""
    if no_proxy:
        return None, "proxy disabled"
    if proxy:
        return proxy, "configured"
    u = urllib.parse.urlsplit(url)
    proxies = urllib.request.getproxies() if env_proxies is None else env_proxies
    chosen = proxies.get(u.scheme)
    if not chosen:
        return None, "no proxy configured and none in HTTPS_PROXY / system settings"
    check = urllib.request.proxy_bypass if bypass is None else bypass
    try:
        bypassed = bool(check(u.hostname or ""))
    except Exception:
        bypassed = False
    if bypassed:
        return None, "host is in NO_PROXY / the system bypass list"
    return chosen, f"{u.scheme.upper()}_PROXY or the system proxy settings"


def _tcp_probe(host, port, timeout):
    socket.create_connection((host, port), timeout=timeout).close()


def _no_secrets(text, proxy):
    """Remove the proxy's user / password from a message (belt and braces)."""
    text = str(text)
    if proxy:
        u = urllib.parse.urlsplit(_with_scheme(proxy))
        for part in (u.password, u.username):
            if part:
                for form in {part, urllib.parse.unquote(part)}:
                    if len(form) >= 2:
                        text = text.replace(form, "***")
    return text


def _inner(err):
    """The exception behind a urllib failure (URLError wraps OSError / SSLError / timeouts)."""
    if isinstance(err, urllib.error.URLError) and not isinstance(err, urllib.error.HTTPError):
        reason = err.reason
        return reason if isinstance(reason, BaseException) else OSError(str(reason))
    return err


TUNNEL_HINTS = {
    "407": "the proxy wants credentials: use http://user:password@host:port as the proxy",
    "403": "the proxy refuses to tunnel to this host / port: allow CONNECT to port 7891 (some proxies only tunnel 443)",
    "405": "this proxy does not support CONNECT: use an HTTP proxy that does (Clash / mihomo mixed-port or port)",
    "502": "the proxy could not reach the hub: check the Clash rule / node for the hub address, the server firewall (port 7891) and that dsh-hub runs",
    "503": "the proxy could not reach the hub: check the Clash rule / node for the hub address, the server firewall (port 7891) and that dsh-hub runs",
    "504": "the proxy timed out reaching the hub: check the Clash rule / node for the hub address and the server firewall (port 7891)",
}


def diagnose(err, url, proxy=None):
    """(what failed, what to do) for a failed GET /v1/health. Never contains proxy credentials."""
    shown = mask_url(_with_scheme(proxy)) if proxy else None
    host = urllib.parse.urlsplit(url).netloc
    if isinstance(err, urllib.error.HTTPError):
        try:
            body = json.loads(err.read().decode("utf-8")).get("error", {})
        except Exception:
            body = {}
        code = body.get("code") if isinstance(body, dict) and isinstance(body.get("code"), str) else f"http-{err.code}"
        if err.code == 403 and code == "ip-not-allowed":
            seen = body.get("client_ip") if isinstance(body, dict) and isinstance(body.get("client_ip"), str) else None
            ip = seen or "<the address the hub sees>"
            hint = f"add {ip} to \"allow\" in hub.json on the server"
            if proxy:
                hint += (f", or pin the hub address to one fixed proxy node in Clash (e.g. - IP-CIDR,<server IP>/32,<node>) "
                         f"so the exit IP stays the same; through {shown} the hub sees the node's exit IP, not this machine's")
            what = "the hub answered 403 ip-not-allowed" + (f" (it sees this client as {seen})" if seen else "")
            return what, hint
        if err.code == 407:
            return "the proxy answered 407 Proxy Authentication Required", TUNNEL_HINTS["407"]
        return f"the hub answered HTTP {err.code} {code}", "the hub is reachable but unhappy: look at its log (journalctl -u dsh-hub)"
    r = _inner(err)
    text = _no_secrets(r, proxy)
    if isinstance(r, ssl.SSLCertVerificationError) or "CERTIFICATE_VERIFY_FAILED" in text:
        detail = getattr(r, "verify_message", None) or "certificate verify failed"
        hint = ("for a self-signed hub pass --cafile <the hub certificate or its CA, PEM>; the host in hubUrl must be "
                "a name / IP the certificate lists")
        if proxy:
            hint += "; and the proxy must not intercept TLS (Clash / mihomo do not by default)"
        return f"TLS certificate of {host} rejected ({detail})", hint
    if "Tunnel connection failed" in text:
        m = re.search(r"Tunnel connection failed:\s*(\d{3})\s*(.*)", text)
        status = m.group(1) if m else "?"
        what = f"the proxy {shown} refused CONNECT {host}: HTTP {status} {m.group(2).strip() if m else ''}".rstrip()
        return what, TUNNEL_HINTS.get(status, "the proxy refused the tunnel: check its rules for the hub address")
    if isinstance(r, ssl.SSLError):
        return (f"TLS handshake with {host} failed ({getattr(r, 'reason', None) or text})",
                "does the hub serve https on this port (\"tls\" in hub.json)? A hub without TLS only listens on 127.0.0.1")
    if isinstance(r, (socket.timeout, TimeoutError)) or "timed out" in text:
        via = f" via {shown}" if proxy else ""
        hint = "hub unreachable: check that dsh-hub runs, that the server firewall / security group opens 7891"
        hint += ", and the Clash rule / node for the hub address" if proxy else ", and the network path"
        return f"no answer from {host}{via} within the timeout", hint
    if isinstance(r, socket.gaierror):
        name = urllib.parse.urlsplit(_with_scheme(proxy)).hostname if proxy else urllib.parse.urlsplit(url).hostname
        return f"cannot resolve {name}", "check the host name in " + ("the proxy URL" if proxy else "hubUrl")
    if isinstance(r, ConnectionRefusedError):
        if proxy:
            return f"connection refused while going through {shown}", "start Clash / mihomo, or pass --no-proxy"
        return (f"connection refused by {host}",
                "nothing listens there: systemctl status dsh-hub; check port (default 7891) and host in hub.json")
    if isinstance(r, ConnectionResetError):
        who = "the proxy or the hub" if proxy else "the hub"
        return f"connection to {host} dropped by {who}", "check the hub log, and the proxy log / rule for the hub address"
    return f"request failed: {type(r).__name__}: {text}", "check hubUrl, the proxy and the hub log"


def run_check(url, proxy=None, no_proxy=False, cafile=None, insecure=False, timeout=15, source=None,
              opener=None, env_proxies=None, bypass=None, probe=None, clock=time.monotonic, out=print):
    """GET <hub>/v1/health once and report how it went. No token is sent or read. Returns 0 / 1."""
    target = hub_url(url) + "/health"
    u = urllib.parse.urlsplit(target)
    eff, how = effective_proxy(target, proxy, no_proxy, env_proxies, bypass)
    label = source or how
    shown = mask_url(_with_scheme(eff)) if eff else None
    out(f"target:  {target}")
    out(f"proxy:   {shown}  [{label}]" if eff else f"proxy:   none, direct connection  [{label}]")
    if u.port == 7890:
        out("note:    port 7890 is the local Clash/mihomo proxy port on MYDESK; dsh-hub listens on 7891 by default")
    if u.scheme == "http" and u.hostname not in LOOPBACK_HOSTS:
        out("note:    plain http to a non-loopback host: a worker token would cross the network in clear text")
    if no_proxy and is_public_host(u.hostname):
        out(f"note:    DSH_HUB_PROXY=off and {u.hostname} is a public address: direct connection. If it fails or the hub "
            "refuses this IP, try the proxy (DSH_HUB_PROXY=http://127.0.0.1:7890)")

    def failed(what, hint, elapsed=None):
        if elapsed is not None:
            out(f"time:    {elapsed:.0f} ms")
        out(f"result:  FAILED - {_no_secrets(what, eff)}")
        out(f"hint:    {_no_secrets(hint, eff)}")
        return 1

    started = clock()
    if eff:
        pu = urllib.parse.urlsplit(_with_scheme(eff))
        try:
            pport = pu.port or (443 if pu.scheme == "https" else 80)
        except ValueError:
            return failed(f"bad port in the proxy URL {shown}", "use http://127.0.0.1:7890 (Clash / mihomo)")
        try:
            (probe or _tcp_probe)(pu.hostname, pport, min(timeout, 5))
        except OSError as e:
            return failed(f"the proxy {shown} does not accept connections ({type(e).__name__})",
                          "the proxy is not running: start Clash / mihomo and check its port (mixed-port / port in "
                          "its config), or pass --no-proxy to connect directly", (clock() - started) * 1000)
    if u.scheme == "http":
        tls = "none (plain http)"
    elif insecure:
        tls = "NOT verified (--insecure)"
    else:
        tls = f"verified ({'CA file ' + cafile if cafile else 'system CA store'}; host {u.hostname})"
    req = urllib.request.Request(target, method="GET")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", f"dsh-agent-client/{PROTOCOL} check")
    if opener is None:
        ctx = make_ssl_context(cafile, insecure)
        # Exactly the proxy reported above, not urllib's own guess.
        opener = build_opener(ctx, proxy=eff) if eff else build_opener(ctx, no_proxy=True)
    try:
        with opener.open(req, timeout=timeout) as res:
            payload = res.read()
    except Exception as e:  # noqa: BLE001 -- every failure becomes a report line
        what, hint = diagnose(e, target, eff)
        if u.scheme == "https" and ("TLS" in what or "certificate" in what):
            out("tls:     FAILED")
        return failed(what, hint, (clock() - started) * 1000)
    elapsed = (clock() - started) * 1000
    out(f"tls:     {tls}")
    out(f"time:    {elapsed:.0f} ms")
    try:
        data = json.loads(payload.decode("utf-8"))
    except Exception:
        data = None
    if not isinstance(data, dict) or data.get("ok") is not True:
        return failed("the answer is not a dsh-hub health response",
                      "is hubUrl really dsh-hub (default port 7891)? 7890 is the proxy itself")
    out(f"hub:     ok, version {data.get('version') or '?'}")
    if isinstance(data.get("client_ip"), str):
        out(f"seen as: {data['client_ip']}  (the address the hub's allow list checks)")
    out("result:  OK - hub reachable" + (f" through {shown}" if eff else " directly"))
    return 0


def is_public_host(host):
    """True for names (other than localhost) and global IP addresses."""
    import ipaddress
    h = (host or "").strip("[]").lower()
    if not h or h in ("localhost",) or h.endswith(".local") or h.endswith(".lan"):
        return False
    try:
        return ipaddress.ip_address(h).is_global
    except ValueError:
        return "." in h


def _proxy_source(st):
    """Where the proxy choice came from, for the check report."""
    src = st["sources"].get("proxy", "default")
    if src == "cli":
        return "--no-proxy" if st["no_proxy"] else "--proxy"
    if src in ("env", ".env"):
        return f"DSH_HUB_PROXY ({'process environment' if src == 'env' else 'worker/.env'})"
    if src == "profile":
        return 'profile "proxy"'
    return None


ENV_TEMPLATE = """\
# How this machine reaches the dsh-hub: <DSH home>/worker/.env (keep it private: chmod 600).
# Only connection settings live here. What each agent is (profile, capabilities, role, ...) lives in
# agents/<agent-id>.json; its token in tokens/<agent-id>.token; its exchange in exchange/<agent-id>/.
# Never put DSH_* variables in <DSH home>/.env: DSH itself refuses to start when its own .env has one.
# Check everything with: python agent_client.py doctor

# Hub address: host, host:port or URL (default port 7891, path /v1), e.g. https://hub.example.com:7891.
# Prefer a domain name: the server IP may change. Never commit the real address.
DSH_HUB_URL=
# Way out to the hub: off = direct, env = HTTPS_PROXY / system proxy, http://host:port = this HTTP proxy
DSH_HUB_PROXY=off
# CA file (PEM) when the hub certificate is self-signed; empty = system CAs
DSH_HUB_CAFILE=
# Which agents/<id>.json to run when there are several (one file = picked automatically)
DSH_AGENT=
"""


# --- one-time move from the older layout ---------------------------------------------

def _bak(path):
    """Rename `path` to `path.bak` (or .bak2, .bak3 ... when taken). Returns the new name."""
    n, dest = 1, path + ".bak"
    while os.path.exists(dest):
        n += 1
        dest = f"{path}.bak{n}"
    os.replace(path, dest)
    return dest


def _env_value(name, env, dotenv):
    for table in (env, dotenv):
        v = table.get(name)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def migrate_layout(worker_dir, env=None, dotenv=None, home=None, log=warn):
    """Move an older worker folder (profile.json / workspaces.json, agent.token, exchange/, DSH_* agent
    settings in .env) to agents/<id>.json + tokens/<id>.token + exchange/<id>/ + a .env with connection
    settings only. Every file it replaces is kept as <name>.bak. Does nothing when agents/ already has a
    config or there is nothing old to move. Returns [(old, new), ...] of what moved, or [] .

    The exchange folder only moves when it is the default <worker>/exchange; an exchange folder set
    elsewhere (DSH_EXCHANGE=E:/...) stays where it is and is written into the agent config."""
    env = os.environ if env is None else env
    dotenv = dict(dotenv or {})
    home = home or dsh_home(env)
    if agent_configs(worker_dir):
        return []
    prof = os.path.join(worker_dir, "profile.json")
    legacy = os.path.join(worker_dir, "workspaces.json")
    src = prof if os.path.isfile(prof) else legacy if os.path.isfile(legacy) else None
    cfg = {}
    if src:
        with open(src, encoding="utf-8-sig") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict):
            raise ConfigError(f"{src}: top level must be an object")
    if _env_value("DSH_AGENT_TOKEN_FILE", env, dotenv):
        token_src = _local_path(_env_value("DSH_AGENT_TOKEN_FILE", env, dotenv), worker_dir)
    elif isinstance(cfg.get("tokenFile"), str) and cfg["tokenFile"].strip():
        token_src = _local_path(cfg["tokenFile"], os.path.dirname(src))
    else:
        token_src = os.path.join(worker_dir, "agent.token")
    if src is None and not os.path.isfile(token_src):
        return []  # a fresh folder: nothing to move
    agent_id = cfg.get("agentId") or _env_value("DSH_AGENT_ID", env, dotenv)
    if not agent_id and os.path.isfile(token_src):
        try:
            agent_id = agent_id_from_token(read_token(token_src))
        except (OSError, ConfigError):
            agent_id = None
    if not agent_id or not AGENT_ID_RE.fullmatch(agent_id):
        log("older worker folder found but its agent name is unknown; set DSH_AGENT_ID in worker/.env (or \"agentId\" "
            "in profile.json) and start again to move it to agents/<id>.json")
        return []
    paths = agent_paths(worker_dir, agent_id)
    moved = []
    new_cfg = {"agentId": agent_id}
    for key, value in cfg.items():
        if key in ("hubUrl", "tokenFile", "proxy", "agentId"):
            continue
        new_cfg["dshProfile" if key == "profile" else key] = value
    for name, key in AGENT_ENV_KEYS.items():
        v = _env_value(name, env, dotenv)
        if v is None or key in new_cfg:
            continue
        if key in ("maxConcurrency", "pullEverySeconds", "heartbeatSeconds"):
            try:
                v = int(v)
            except ValueError:
                continue
        elif key == "capabilities":
            v = [c.strip() for c in v.split(",") if c.strip()]
        elif key == "exchange":
            v = _local_path(v, worker_dir)
        new_cfg[key] = v
    dp = new_cfg.get("dshProfile")
    if isinstance(dp, str) and dp.strip():  # a path under <home>/profiles/ becomes its bare name
        full = _local_path(dp, os.path.dirname(src) if src else worker_dir)
        if os.path.normcase(os.path.dirname(full.rstrip("\\/"))) == os.path.normcase(os.path.join(home, PROFILES_DIR)):
            new_cfg["dshProfile"] = os.path.basename(full.rstrip("\\/"))
        else:
            new_cfg["dshProfile"] = full
    # token (and a pending enrollment) -> tokens/<id>.token
    for suffix in ("", ".enroll.json"):
        old = token_src + suffix
        if os.path.isfile(old):
            new = paths["token"] + suffix
            os.makedirs(os.path.dirname(new), exist_ok=True)
            shutil.copyfile(old, new)
            _private(new)
            moved.append((old, new))
            _bak(old)
    # the default exchange folder -> exchange/<id>/
    if "exchange" not in new_cfg:
        old_ex = os.path.join(worker_dir, EXCHANGE_BASE)
        if any(os.path.isdir(os.path.join(old_ex, d)) for d in EXCHANGE_DIRS):
            os.makedirs(paths["exchange"], exist_ok=True)
            for item in EXCHANGE_DIRS + ("README.md",):
                a = os.path.join(old_ex, item)
                if os.path.exists(a):
                    os.replace(a, os.path.join(paths["exchange"], item))
            moved.append((old_ex, paths["exchange"]))
    os.makedirs(os.path.dirname(paths["config"]), exist_ok=True)
    write_atomic(paths["config"], json.dumps(new_cfg, ensure_ascii=False, indent=2) + "\n")
    moved.append((src or "(worker/.env)", paths["config"]))
    if src:
        _bak(src)
    # .env: connection settings only, plus DSH_AGENT
    env_path = os.path.join(worker_dir, ".env")
    if os.path.isfile(env_path):
        with open(env_path, encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
        drop = set(AGENT_ENV_KEYS) | {"DSH_AGENT_ID", "DSH_AGENT_TOKEN_FILE", "DSH_AGENT"}
        kept = [ln for ln in lines if not any(re.match(rf"\s*(export\s+)?{k}\s*=", ln) for k in drop)]
        _bak(env_path)
        write_atomic(env_path, "\n".join(kept + [f"# this worker folder's agent (agents/{agent_id}.json)", f"DSH_AGENT={agent_id}"]) + "\n")
        _private(env_path)
        moved.append((env_path + " (agent settings)", paths["config"]))
    for old, new in moved:
        log(f"moved: {old} -> {new}")
    log(f"older layout moved to agents/{agent_id}.json; replaced files are kept as *.bak")
    return moved


def require_profile(st, wm, what):
    """register / run / bridge need the agent to name its local DSH profile (workers and testers)."""
    if st.get("role") in ("dispatcher", "observer"):
        return
    where = wm.config_path or "agents/<id>.json"
    if not wm.profile:
        raise ConfigError(f"{what} needs \"dshProfile\" in {where}: the name of the local DSH profile "
                          f"(<DSH home>/{PROFILES_DIR}/<name>) whose partitions this agent works in")
    if not os.path.exists(profile_patch_path(wm.profile)):
        raise ConfigError(f"dshProfile in {where} points at {wm.profile}, which has no cordis.patch.yml")
    if not getattr(wm, "profile_name", None):
        raise ConfigError(f"dshProfile in {where}: the profile folder name must be letters, digits, . _ - (it is sent to the hub)")


def profile_template(node=None):
    return {"node": node or default_node(), "dshProfile": None, "workspaces": {}}


def agent_template(agent_id, node=None, profile=None):
    """agents/<id>.json of a new agent. dshProfile is required before register / run."""
    return {"agentId": agent_id, "dshProfile": profile or "", "node": node or default_node(), "platform": "custom",
            "role": "worker", "capabilities": {"code": 1}, "maxConcurrency": 1, "pullEverySeconds": None, "workspaces": {}}


def _foreign_drive(path):
    """A Windows drive path (E:/x) on a non-Windows machine: not a usable folder here."""
    return os.name != "nt" and re.match(r"^[A-Za-z]:[\\/]", path or "") is not None


def init_exchange(worker_dir, env=None, cli_value=None, out=print):
    """Resolve DSH_EXCHANGE like `run` does (cli > env > worker/.env > default) and create it."""
    env = os.environ if env is None else env
    if cli_value:
        value, base = cli_value, None
    else:
        dotenv = read_env_file(os.path.join(worker_dir, ".env"), log=lambda *_a, **_k: None)
        value = next((v.strip() for v in (env.get("DSH_EXCHANGE"), dotenv.get("DSH_EXCHANGE"))
                      if isinstance(v, str) and v.strip()), "exchange")
        base = worker_dir
    if _foreign_drive(value):
        out(f"  exchange      skipped: DSH_EXCHANGE={value} is a Windows path; set a local folder in .env")
        return None
    root = _local_path(value, base) if base else os.path.abspath(os.path.expanduser(value))
    created = ensure_exchange(root)
    out(f"  exchange      {root} ({'created: ' + ', '.join(created) if created else 'kept (already exists)'})")
    out("                empty until register is approved, run is running and DSH dispatches a task (see its README.md)")
    return root


def cmd_init(worker_dir, node=None, out=print, exchange=False, env=None, exchange_dir=None, agent=None, profile=None):
    """Write worker/.env and agents/<agent>.json templates (never overwritten) and create exchange/<agent>/."""
    os.makedirs(worker_dir, exist_ok=True)
    done = {}
    env_path = os.path.join(worker_dir, ".env")
    if os.path.exists(env_path):
        done[".env"] = "kept (already exists)"
    else:
        write_atomic(env_path, ENV_TEMPLATE)
        _private(env_path)
        done[".env"] = "created"
    if agent:
        if not AGENT_ID_RE.fullmatch(agent):
            raise ConfigError(f"agent name {agent!r} must match ^[a-z][a-z0-9-]{{1,47}}$")
        paths = agent_paths(worker_dir, agent)
        rel = os.path.relpath(paths["config"], worker_dir)
        if os.path.exists(paths["config"]):
            done[rel] = "kept (already exists)"
        else:
            os.makedirs(os.path.dirname(paths["config"]), exist_ok=True)
            write_atomic(paths["config"], json.dumps(agent_template(agent, node, profile), ensure_ascii=False, indent=2) + "\n")
            done[rel] = "created"
        for d in (TOKENS_DIR, LOGS_DIR):
            os.makedirs(os.path.join(worker_dir, d), exist_ok=True)
    out(f"worker dir: {worker_dir}")
    for name, what in done.items():
        out(f"  {name:<24} {what}")
    if agent and exchange:
        root = os.path.abspath(os.path.expanduser(exchange_dir)) if exchange_dir else agent_paths(worker_dir, agent)["exchange"]
        created = ensure_exchange(root)
        out(f"  exchange                 {root} ({'created: ' + ', '.join(created) if created else 'kept (already exists)'})")
    out("next:")
    if not agent:
        out("  0. python agent_client.py init --agent <name>   (one agents/<name>.json per agent on this machine)")
    out("  1. worker/.env: DSH_HUB_URL (your hub, e.g. https://hub.example.com:7891); DSH_HUB_PROXY=off unless check fails")
    out(f"  2. agents/{agent or '<name>'}.json: dshProfile = the local DSH profile's name ({os.path.join(dsh_home(env), PROFILES_DIR)}/<name>),")
    out("     platform, role, capabilities, maxConcurrency")
    out("  3. python agent_client.py doctor     (every value, where it came from, and what to fix)")
    out("  4. python agent_client.py register   (then in DSH: agent_requests -> agent_approve)")
    out("  5. python agent_client.py run")
    return 0


def cmd_register(st, wm, make_client, a, log=print):
    """Already registered -> say so; a rejected token is moved aside; else enroll and wait."""
    tf = st["token_file"]
    if os.path.isfile(tf):
        token = read_token(tf)
        client = make_client(token)
        try:
            me = client.me()
            log(f"already registered as {client.agent_id} (status {me.get('status', '?')}); token in {tf}. Nothing to do; "
                "start the worker with: python agent_client.py run")
            return 0
        except HubError as e:
            if e.status != 401:
                raise
            aside = tf + ".rejected"
            os.replace(tf, aside)
            log(f"the hub no longer accepts the token in {tf} (401); moved it to {aside} and asking to join again")
    if not st["agent_id"]:
        raise ConfigError("register needs a worker name: DSH_AGENT_ID in worker/.env or --agent-id")
    client = make_client(None)
    return enroll(client, st["platform"], a.mode, st["node"], wm.names(), st["capabilities"], st["max_concurrency"],
                  a.description, tf, tf + ".enroll.json", not a.no_wait, a.interval, log)


def cmd_status(st, wm, make_client, out=print):
    """Local summary (no token) + the hub's view (GET /v1/me). 0 = hub answered or not registered yet."""
    report = {"worker_dir": st["worker_dir"],
              "env_file": {"path": os.path.join(st["worker_dir"], ".env"), "exists": os.path.isfile(os.path.join(st["worker_dir"], ".env"))},
              "profile_file": {"path": wm.config_path, "exists": wm.exists, "legacy": wm.legacy},
              "settings": settings_summary(st), "sources": dict(sorted(st["sources"].items())), "workspaces": wm.names()}
    code = 0
    if not st["url"]:
        report["hub"] = {"skipped": "no hub address (DSH_HUB_URL)"}
    elif not os.path.isfile(st["token_file"]):
        report["hub"] = {"skipped": f"not registered yet (no token file {st['token_file']}): python agent_client.py register"}
    else:
        try:
            report["hub"] = make_client(read_token(st["token_file"])).me()
        except (HubError, OSError, ConfigError) as e:
            report["hub"] = {"error": str(e)}
            code = 1
    out(json.dumps(report, ensure_ascii=False, indent=2))
    return code


SOURCE_ZH = {"cli": "命令行", "env": "进程环境变量", ".env": "worker/.env", "agent": "agent 配置", "profile": "profile.json",
             "default": "默认", "agents/": "agents/ 下唯一的配置"}


def cmd_doctor(wd, env, dotenv, agent, agent_src, wm, st, a, out=print):
    """Startup self-check: every value and where it came from, plus one line per problem (Chinese, for the
    person at the machine). Returns 0 when nothing is wrong (warnings allowed), else 1."""
    bad, notes = [], []
    home = dsh_home(env)
    out(f"DSH home     {home}")
    out(f"worker 目录  {wd}")
    home_env = read_env_file(os.path.join(home, ".env"), log=lambda *_a: None)
    leaked = sorted(k for k in home_env if k.startswith("DSH_"))
    if leaked:
        bad.append(f"{os.path.join(home, '.env')} 里有 {', '.join(leaked)}：DSH 会拒绝启动。把它们挪到 {os.path.join(wd, '.env')}")
    stray = sorted(k for k in AGENT_ENV_KEYS if isinstance(dotenv.get(k), str) and dotenv[k].strip())
    if stray and agent:
        notes.append(f"worker/.env 里的 {', '.join(stray)} 属于 agent 配置，请挪进 agents/{agent}.json（现在仍生效，并且优先于 agent 配置）")
    in_proc = sorted(k for k in list(AGENT_ENV_KEYS) + ["DSH_AGENT_ID", "DSH_AGENT_TOKEN_FILE"] if isinstance(env.get(k), str) and env[k].strip())
    if in_proc:
        notes.append(f"进程环境变量里设了 {', '.join(in_proc)}，会覆盖 agent 配置；不需要的话从启动脚本或系统环境变量里删掉")
    if agent:
        out(f"agent        {agent}（{SOURCE_ZH.get(agent_src, agent_src)}） 配置 {wm.config_path}")
    elif wm.exists:
        notes.append(f"还在用旧的 {wm.config_path}；设好 DSH_AGENT_ID 后再跑一次 doctor 会自动迁到 agents/<id>.json")
        out(f"agent        {st.get('agent_id') or '-'}（旧布局 {wm.config_path}）")
    else:
        bad.append("没有 agent 配置：python agent_client.py init --agent <名字> 会建 agents/<名字>.json")
    if st.get("role") not in ("dispatcher", "observer"):
        if not wm.profile:
            bad.append(f"agent 配置里没写 dshProfile：填本机 DSH profile 的名字（{os.path.join(home, PROFILES_DIR)} 下的文件夹名）")
        elif not os.path.exists(profile_patch_path(wm.profile)):
            bad.append(f"dshProfile 指向 {wm.profile}，那里没有 cordis.patch.yml")
        else:
            out(f"dshProfile   {wm.profile_name or '?'} -> {wm.profile}")
    names = wm.names()
    out(f"工作区       {', '.join(names) if names else '-'}")
    for d in wm.dropped:
        notes.append(f"工作区 {d['name']} 没上报：{d['reason']}（{d.get('path') or '-'}）")
    if not names and st.get("role") in ("worker", "coder", "tester"):
        notes.append("没有可用的工作区：只能接不指定工作区的任务")
    tf = st["token_file"]
    if os.path.isfile(tf):
        out(f"token        {tf}")
        if os.name != "nt" and os.stat(tf).st_mode & 0o077:
            notes.append(f"{tf} 别人也能读：chmod 600 {tf}")
    else:
        notes.append(f"还没注册（没有 {tf}）：python agent_client.py register")
    ex = st["exchange"]
    out(f"交换目录     {ex}")
    if _foreign_drive(ex):
        bad.append(f"交换目录 {ex} 是 Windows 路径，这台机器用不了")
    elif os.path.isdir(ex):
        missing = [d for d in EXCHANGE_DIRS if not os.path.isdir(os.path.join(ex, d))]
        if missing:
            notes.append(f"交换目录缺 {', '.join(missing)}；run 启动时会补上")
        if not os.access(ex, os.W_OK):
            bad.append(f"交换目录 {ex} 不可写")
    else:
        notes.append("交换目录还不存在；run 启动时会建")
    for other in agent_configs(wd):
        if other == agent:
            continue
        try:
            o = resolve_workspaces(agent_paths(wd, other)["config"], log=lambda *_a: None, home=home)
            o_ex = o.machine.get("exchange") or agent_paths(wd, other)["exchange"]
            if os.path.normcase(os.path.abspath(o_ex)) == os.path.normcase(os.path.abspath(ex)):
                bad.append(f"agent {other} 和 {agent} 用的是同一个交换目录 {ex}：会互相抢任务")
        except ConfigError:
            pass
    out(f"日志         {st.get('log_file')}")
    out("")
    out("设置（值 / 来源）")
    summary = settings_summary(st)
    for key in ("hub_url", "proxy", "cafile", "agent_id", "node", "platform", "role", "capabilities", "max_concurrency",
                "pull_every_seconds", "heartbeat_seconds", "token_file", "exchange"):
        src = st["sources"].get({"hub_url": "url"}.get(key, key), "-")
        value = summary.get(key)
        out(f"  {key:<20} {json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value}  [{SOURCE_ZH.get(src, src)}]")
    if not st["url"]:
        bad.append("没有 hub 地址：在 worker/.env 里写 DSH_HUB_URL")
    elif not a.offline:
        out("")
        out("连通性")
        if run_check(st["url"], st["proxy"], st["no_proxy"], st["cafile"], getattr(a, "insecure", False), 15,
                     source=_proxy_source(st), out=lambda m: out("  " + m)) != 0:
            bad.append("连不上 hub：看上面「连通性」的提示")
    out("")
    for line in bad:
        out(f"✗ {line}")
    for line in notes:
        out(f"! {line}")
    if not bad and not notes:
        out("✓ 一切正常")
    elif not bad:
        out("✓ 可以启动（上面的 ! 是提醒）")
    return 1 if bad else 0


def build_parser():
    fmt = argparse.RawDescriptionHelpFormatter
    epilog = config_help()
    p = argparse.ArgumentParser(description=f"dsh-hub worker client ({PROTOCOL})", epilog=epilog, formatter_class=fmt)
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, help_text, net=True, worker=True, aliases=()):
        s = sub.add_parser(name, help=help_text, epilog=epilog, formatter_class=fmt, aliases=list(aliases))
        _add_local_args(s)
        if net:
            _add_net_args(s, worker)
        return s

    i = sub.add_parser("init", help="write .env / profile.json templates (never overwrites) and create the exchange folder", epilog=epilog, formatter_class=fmt)
    i.add_argument("--worker-dir", help="worker folder (default <DSH home>/worker)")
    i.add_argument("--agent", help="create agents/<agent>.json, tokens/, logs/ and exchange/<agent>/")
    i.add_argument("--dsh-profile", help="local DSH profile name for the new agent config (<DSH home>/profiles/<name>)")
    i.add_argument("--node", help="node name for the agent config (default: host name)")
    i.add_argument("--exchange", help="exchange folder to create (default: exchange/<agent>)")
    i.add_argument("--no-exchange", action="store_true", help="only write the templates, do not create the exchange folder")
    add("workspaces", "print the local workspace map and file settings, then exit (no network)", net=False)
    add("paths", "print where the selected agent's exchange, token and log files are (JSON, no network)", net=False)
    dr = add("doctor", "self-check: every setting and where it came from, the profile, workspaces, token, exchange and the hub", worker=False)
    dr.add_argument("--offline", action="store_true", help="skip the hub connection test")
    dr.set_defaults(timeout=15)
    c = add("check", "GET /v1/health through the configured proxy and report (no token)", worker=False)
    c.set_defaults(timeout=15)
    e = add("register", "ask the hub to register this worker, wait for approval, save the token", aliases=("enroll",))
    e.add_argument("--platform", help="overrides DSH_PLATFORM (default custom)")
    e.add_argument("--mode", choices=["poll", "push"], default="poll")
    e.add_argument("--capabilities", help="comma separated; overrides DSH_CAPABILITIES")
    e.add_argument("--max-concurrency", type=int, help="overrides DSH_MAX_CONCURRENCY (default 1)")
    e.add_argument("--description", default="")
    e.add_argument("--role", choices=list(ROLES), help="overrides DSH_ROLE (default worker); approval may narrow it")
    e.add_argument("--pull-every-seconds", type=int, help="overrides DSH_PULL_EVERY_SECONDS (scheduled pullers)")
    e.add_argument("--no-wait", action="store_true", help="ask (or check the pending request) once and exit")
    e.add_argument("--interval", type=int, default=30, help="seconds between approval checks")
    r = add("run", "stay online: heartbeat + long poll, sync tasks with the exchange folder")
    r.add_argument("--exchange", help="overrides DSH_EXCHANGE")
    r.add_argument("--heartbeat-seconds", type=int, help="overrides DSH_HEARTBEAT_SECONDS (default 30)")
    r.add_argument("--max", type=int, help="tasks held at once (default: DSH_MAX_CONCURRENCY)")
    r.add_argument("--wait", type=int, default=DEFAULT_WAIT, help=f"long-poll seconds (0..{MAX_WAIT}, default {DEFAULT_WAIT})")
    add("status", "local settings (no token) and the hub's view of this worker (GET /v1/me)")
    lv = add("leave", "go offline now; the hub requeues the tasks this worker holds")
    lv.add_argument("--reason", help="short note for the task history")
    b = add("bridge", "sync this worker's tasks with the exchange folder (--once for schedulers)")
    b.add_argument("--exchange", help="overrides DSH_EXCHANGE")
    b.add_argument("--once", action="store_true")
    b.add_argument("--pull-every-seconds", type=int, help="overrides DSH_PULL_EVERY_SECONDS: how often cron runs this (--once)")
    b.add_argument("--interval", type=int, default=60)
    b.add_argument("--max", type=int, default=1)
    b.add_argument("--wait", type=int, default=DEFAULT_WAIT, help=f"long-poll seconds (0..{MAX_WAIT}, default {DEFAULT_WAIT})")
    cl = add("claim", "atomically claim inbox/<task_id> -> working/<task_id> with O_EXCL claim.json (no network)", net=False)
    cl.add_argument("--exchange", help="overrides DSH_EXCHANGE")
    cl.add_argument("--task-id", required=True, help="task_id inside inbox/ to claim")
    cl.add_argument("--by", default="worker", help="claimant name recorded in claim.json")
    cl.add_argument("--nonce", help="unique run nonce recorded in claim.json")
    return p


def _resolve(a, cmd, wd, env):
    """Every setting of the selected agent, the same way for every command (and for worker_run.py /
    worker_executor.py through resolve_files): (dotenv, agent, agent source, workspace map, settings)."""
    dotenv = read_env_file(os.path.join(wd, ".env"))
    home = dsh_home(env)
    if a.profile_file is None and cmd != "claim" and migrate_layout(wd, env, dotenv, home, log=lambda m: print(m, file=sys.stderr)):
        dotenv = read_env_file(os.path.join(wd, ".env"))
    agent, agent_src = (None, None) if a.profile_file else select_agent(wd, env, dotenv, a.agent)
    profile_file = a.profile_file or (agent_paths(wd, agent)["config"] if agent else None)
    raw_map = next((v for v in (env.get("DSH_PATH_MAP"), dotenv.get("DSH_PATH_MAP")) if isinstance(v, str) and v.strip()), "")
    wm = resolve_workspaces(profile_file, a.node, required=profile_file is not None, worker_dir=wd,
                            path_map=parse_path_map(raw_map), home=home)
    cli = {k: getattr(a, k, None) for k in ("cafile", "agent_id", "node", "platform", "capabilities",
                                            "max_concurrency", "exchange", "heartbeat_seconds",
                                            "role", "pull_every_seconds")}
    st = resolve_settings(wm, getattr(a, "url", None), getattr(a, "token_file", None), getattr(a, "proxy", None),
                          getattr(a, "no_proxy", False), env=env, dotenv=dotenv, worker_dir=wd, cli=cli, agent=agent)
    wm.node = st["node"]
    return dotenv, agent, agent_src, wm, st


def files_of(st):
    """Where the selected agent's files are: what worker_run.py and worker_executor.py use."""
    wd, agent = st["worker_dir"], st.get("agent")
    layout = agent_paths(wd, agent) if agent else None
    return {"agent": agent, "agent_id": st.get("agent_id"), "dsh_profile": st.get("dsh_profile"), "worker_dir": wd,
            "exchange": os.path.abspath(st["exchange"]), "token_file": st.get("token_file"),
            "log_file": st.get("log_file"),
            "executor_log": layout["executor_log"] if layout else os.path.join(wd, "executor.log"),
            "executor_lock": os.path.join(os.path.abspath(st["exchange"]), ".executor.lock")}


def resolve_files(worker_dir=None, agent=None, env=None):
    """files_of() for the agent that `agent_client.py run [--agent X]` would run. Raises ConfigError."""
    env = os.environ if env is None else env
    argv = ["paths"] + (["--worker-dir", worker_dir] if worker_dir else []) + (["--agent", agent] if agent else [])
    a = build_parser().parse_args(argv)
    wd = os.path.abspath(os.path.expanduser(a.worker_dir)) if a.worker_dir else default_worker_dir(env)
    st = _resolve(a, "paths", wd, env)[4]
    return files_of(st)


def main(argv=None, env=None):
    p = build_parser()
    a = p.parse_args(argv)
    env = os.environ if env is None else env
    cmd = "register" if a.cmd == "enroll" else a.cmd
    try:
        wd = os.path.abspath(os.path.expanduser(a.worker_dir)) if a.worker_dir else default_worker_dir(env)
        if cmd == "init":
            agent_name = a.agent or (env.get("DSH_AGENT") or "").strip() or None
            return cmd_init(wd, a.node, exchange=not a.no_exchange, env=env, exchange_dir=a.exchange, agent=agent_name,
                            profile=a.dsh_profile)
        dotenv, agent, agent_src, wm, st = _resolve(a, cmd, wd, env)
        if cmd == "paths":
            print(json.dumps(files_of(st), ensure_ascii=False, indent=2))
            return 0
        if cmd == "doctor":
            return cmd_doctor(wd, env, dotenv, agent, agent_src, wm, st, a)
        if cmd in ("register", "run", "bridge"):
            require_profile(st, wm, cmd)
        if cmd == "workspaces":
            out = wm.to_json()
            out["settings"] = settings_summary(st)
            print(json.dumps(out, ensure_ascii=False, indent=2))
            return 0
        if cmd == "claim":
            res = claim_task(st["exchange"], a.task_id, by=a.by, nonce=a.nonce)
            print(json.dumps(res, ensure_ascii=False, indent=2))
            return 0 if res.get("claimed") else 1
        make = lambda token, agent_id=None: _client(st, token, wm.names(), a, agent_id)  # noqa: E731
        if cmd == "status":
            return cmd_status(st, wm, make)
        check_settings(st)
        if cmd == "check":
            return run_check(st["url"], st["proxy"], st["no_proxy"], st["cafile"], a.insecure, a.timeout,
                             source=_proxy_source(st))
        if cmd == "register":
            return cmd_register(st, wm, make, a)
        client = make(read_token(st["token_file"]))
        if cmd == "leave":
            print(json.dumps(client.leave(a.reason), ensure_ascii=False, indent=2))
            return 0
    except ConfigError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    except OSError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    except HubError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    exchange = os.path.abspath(st["exchange"])
    max_tasks = a.max if a.max is not None else st["max_concurrency"]
    br = Bridge(client, exchange, max_tasks, workspaces=wm.workspaces, node=wm.node, wait=a.wait, host_paths=wm.host_paths)
    print(f"{cmd}: {client.agent_id} on node {wm.node} -> {client.url}; exchange {exchange}; "
          f"workspaces: {', '.join(wm.names()) or '-'}", file=sys.stderr)
    if cmd == "run":
        runner = Runner(br, st["heartbeat_seconds"], a.wait, log=lambda m: print(m, file=sys.stderr))
        try:
            runner.run()
        except HubError as err:
            print(f"error: {err} (token revoked? run: python agent_client.py status)", file=sys.stderr)
            return 1
        except KeyboardInterrupt:
            print("stopped; the hub shows this worker offline after 90 s (python agent_client.py leave = at once)", file=sys.stderr)
            return 0
    while True:
        try:
            pulled, pushed = br.tick()
            if a.once:
                print(json.dumps({"pulled": pulled, "pushed": pushed, "rejected": br.rejected, "aborted": br.aborted}))
                return 0
        except (HubError, OSError) as err:
            print(f"error: {err}", file=sys.stderr)
            if a.once:
                return 1
        time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
