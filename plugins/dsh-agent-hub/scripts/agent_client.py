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
             are never overwritten) and print the next steps. No network.
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
     task's workspace, or null), `node` (this machine) and `exchange` (where to put
     the result). If the task names a `ref`, the agent checks it out first; the
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
  DSH_CAPABILITIES       --capabilities       comma separated, for pool:<capability> tasks.
                                              Default: none.
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

profile.json keys (all optional; unknown keys are ignored):
  node        node name (see DSH_NODE).
  dshProfile  local DSH profile folder, or its cordis.patch.yml. The router-b partitions
              in it (host-router entry, partitions[].name -> partitions[].root) form the
              base workspace map. Legacy name: profile. Default: none.
  workspaces  Object {name: local path}. Overrides a dshProfile partition of the same
              name and adds new names; null hides a name the dshProfile would provide.
              An explicit path that does not exist is dropped; it does NOT fall back
              to the dshProfile path. Default: {}.
  hubUrl, tokenFile, proxy
              lowest-priority fallbacks of DSH_HUB_URL, DSH_AGENT_TOKEN_FILE and
              DSH_HUB_PROXY (proxy false = off), kept for older workspaces.json files.

Workspace map (contract section 3), highest priority first:
  1. "workspaces" in profile.json;
  2. router-b partitions of "dshProfile".
Workspaces whose path does not exist are dropped with a warning and never
reported. Only workspace NAMES leave this machine (register and every heartbeat);
paths only go into the local task.json as workspace_path.

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
ENV_KEYS = ("DSH_HUB_URL", "DSH_HUB_PROXY", "DSH_HUB_CAFILE", "DSH_AGENT_ID", "DSH_NODE", "DSH_PLATFORM",
            "DSH_CAPABILITIES", "DSH_MAX_CONCURRENCY", "DSH_AGENT_TOKEN_FILE", "DSH_EXCHANGE", "DSH_HEARTBEAT_SECONDS")
PROXY_OFF = ("off", "direct", "none", "false", "no")
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
                 proxy=None, no_proxy=False, workspaces=(), opener=None, ctx=None):
        self.url = hub_url(url)
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
        return self._req("POST", "enroll", body, auth=False)

    def enroll_status(self, request_id, poll_secret):
        return self._req("POST", "enroll/status", {"request_id": request_id, "poll_secret": poll_secret}, auth=False)

    # worker calls (token)
    def heartbeat(self, status="idle", workspaces=None, running=None):
        """`running` (task ids still held locally) lets the hub reconcile: it answers `abort`."""
        names = self.workspaces if workspaces is None else list(workspaces)
        body = {"status": status, "workspaces": names, "client_version": CLIENT_VERSION}
        if running is not None:
            body["running"] = list(running)
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

    def progress(self, task_id, progress=None, message=None):
        return self._req("POST", "event", {"task_id": task_id, "progress": progress, "message": message})

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


def _local_path(path, base=None):
    p = os.path.expanduser(path.strip())
    if base is not None and not _is_abs(p):
        p = os.path.join(base, p)
    return os.path.abspath(p)


class WorkspaceMap:
    def __init__(self, node, config_path, profile, workspaces, sources, dropped, hub_url=None, token_file=None, proxy=None,
                 file_node=None, legacy=False, exists=False):
        self.node, self.config_path, self.profile = node, config_path, profile
        self.workspaces, self.sources, self.dropped = workspaces, sources, dropped
        # connection settings from profile.json / workspaces.json (None = not set; proxy False = direct)
        self.hub_url, self.token_file, self.proxy = hub_url, token_file, proxy
        self.file_node, self.legacy, self.exists = file_node, legacy, exists

    def names(self):
        """Names safe to report: mapped and still present on disk."""
        return sorted(n for n, p in self.workspaces.items() if os.path.isdir(p))

    def to_json(self):
        proxy = self.proxy if self.proxy in (None, False) else mask_url(self.proxy)
        return {"node": self.node, "workspaces_file": self.config_path, "profile": self.profile,
                "workspaces": dict(sorted(self.workspaces.items())), "sources": dict(sorted(self.sources.items())),
                "dropped": self.dropped,
                "file_settings": {"hubUrl": self.hub_url, "tokenFile": self.token_file, "proxy": proxy}}


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


def resolve_workspaces(config_path=None, node=None, required=False, log=warn, isdir=os.path.isdir, worker_dir=None):
    """Merge profile.json "workspaces" (explicit, wins) over the dshProfile's router-b partitions.

    `config_path` names the file (profile.json or a legacy workspaces.json); without it the
    worker dir is searched: profile.json, then workspaces.json."""
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

    candidates, sources, dropped = {}, {}, []
    profile = config.get("dshProfile", config.get("profile"))
    if profile is not None and not isinstance(profile, str):
        raise ConfigError(f"{path}: dshProfile must be a string")
    if profile:
        profile = _local_path(profile, base)
        patch = profile_patch_path(profile)
        if os.path.isfile(patch):
            with open(patch, encoding="utf-8-sig") as f:
                for p in parse_partitions(f.read(), log):
                    root = p["root"]
                    if not root:
                        dropped.append({"name": p["name"], "path": None, "source": "profile", "reason": "no root"})
                        log(f"workspace {p['name']}: partition has no root; ignored")
                        continue
                    if not _is_abs(os.path.expanduser(root)):
                        dropped.append({"name": p["name"], "path": root, "source": "profile", "reason": "root not absolute"})
                        log(f"workspace {p['name']}: partition root is not absolute: {root}; ignored")
                        continue
                    candidates[p["name"]] = _local_path(root)
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
            if name in candidates:
                dropped.append({"name": name, "path": candidates.pop(name), "source": sources.pop(name), "reason": "hidden by workspaces.json"})
            continue
        if not isinstance(value, str) or not value.strip():
            log(f"workspace {name}: path must be a non-empty string; ignored")
            continue
        candidates[name] = _local_path(value, base)
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
    proxy = config.get("proxy")
    if proxy is True or not (proxy is None or proxy is False or isinstance(proxy, str)):
        raise ConfigError(f"{path}: proxy must be a URL string, false (direct) or null")
    if isinstance(proxy, str):
        proxy = normalize_proxy(proxy) if proxy.strip() else None
    return WorkspaceMap(node, path, profile or None, workspaces, sources, dropped, hub, token_file, proxy,
                        file_node=file_node, legacy=legacy, exists=exists)


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


def resolve_settings(wm, url=None, token_file=None, proxy=None, no_proxy=False, env=None, dotenv=None, worker_dir=None, cli=None):
    """All settings. Order: command line > process env > worker/.env > profile.json > default.

    Returns a dict with url, proxy, no_proxy, cafile, agent_id, node, platform, capabilities,
    max_concurrency, token_file, exchange, heartbeat_seconds, worker_dir and `sources`
    (key -> "cli" | "env" | ".env" | "profile" | "default"). url may be None."""
    env = os.environ if env is None else env
    dotenv = dotenv or {}
    cli = dict(cli or {})
    wd = worker_dir or default_worker_dir(env)
    sources = {}

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
            sources[key] = "profile"
            return profile_value
        sources[key] = "default"
        return default

    def in_wd(value, key):
        if value is None:
            return None
        if sources[key] == "cli":
            return os.path.abspath(os.path.expanduser(value))
        if sources[key] == "profile":
            return value  # already resolved against the profile file
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
                sources["proxy"] = "profile"
                st["proxy"], st["no_proxy"] = None, True
            elif wm.proxy:
                sources["proxy"] = "profile"
                st["proxy"], st["no_proxy"] = wm.proxy, False
            else:
                st["proxy"], st["no_proxy"] = None, False
        else:
            try:
                st["proxy"], st["no_proxy"] = parse_proxy_choice(raw)
            except ConfigError:
                raise ConfigError(f"DSH_HUB_PROXY / --proxy must be http://host:port, off or env (from {sources['proxy']})") from None
    st["cafile"] = in_wd(pick("cafile", "DSH_HUB_CAFILE", cli.get("cafile")), "cafile")
    agent_id = pick("agent_id", "DSH_AGENT_ID", cli.get("agent_id"))
    if agent_id is not None and not AGENT_ID_RE.fullmatch(agent_id):
        raise ConfigError(f"DSH_AGENT_ID / --agent-id must match ^[a-z][a-z0-9-]{{1,47}}$ (from {sources['agent_id']})")
    st["agent_id"] = agent_id
    st["node"] = pick("node", "DSH_NODE", cli.get("node"), wm.file_node, default_node())
    st["platform"] = pick("platform", "DSH_PLATFORM", cli.get("platform"), None, "custom")
    caps = pick("capabilities", "DSH_CAPABILITIES", cli.get("capabilities"), None, "")
    st["capabilities"] = [c.strip() for c in (caps if isinstance(caps, str) else ",".join(caps)).split(",") if c.strip()]
    st["max_concurrency"] = _int_setting(pick("max_concurrency", "DSH_MAX_CONCURRENCY", cli.get("max_concurrency"), None, 1),
                                         "DSH_MAX_CONCURRENCY", 1, 32)
    st["token_file"] = in_wd(pick("token_file", "DSH_AGENT_TOKEN_FILE", token_file, wm.token_file, "agent.token"), "token_file")
    st["exchange"] = in_wd(pick("exchange", "DSH_EXCHANGE", cli.get("exchange"), None, "exchange"), "exchange")
    st["heartbeat_seconds"] = _int_setting(pick("heartbeat_seconds", "DSH_HEARTBEAT_SECONDS", cli.get("heartbeat_seconds"), None,
                                                DEFAULT_HEARTBEAT), "DSH_HEARTBEAT_SECONDS", 5, 3600)
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
            "exchange": st["exchange"], "heartbeat_seconds": st["heartbeat_seconds"]}


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


def _upload_order(name):
    return ({"changes.patch": 0, "summary.md": 1}.get(name, 2), name)


class Bridge:
    def __init__(self, client, root, max_tasks=1, log=print, workspaces=None, node=None, wait=DEFAULT_WAIT):
        self.c, self.root, self.max, self.log = client, root, max_tasks, log
        self.workspaces = dict(workspaces or {})
        self.node = node
        self.wait = wait
        self.rejected = 0
        self.aborted = 0
        self.full = False
        for d in EXCHANGE_DIRS:
            os.makedirs(os.path.join(root, d), exist_ok=True)

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

    def _known(self, task_id):
        return any(os.path.exists(os.path.join(self.root, d, task_id)) for d in EXCHANGE_DIRS)

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
        busy = len(os.listdir(os.path.join(self.root, "inbox"))) + len(os.listdir(os.path.join(self.root, "working")))
        room = max(0, self.max - busy)
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
            t["node"] = self.node
            t["exchange"] = {"result_dir": f"outbox/{tid}", "failed_dir": f"failed/{tid}",
                             "outputs": "changes.patch, summary.md and any other files; write result.json LAST"}
            write_atomic(os.path.join(stage, "task.json"), json.dumps(t, ensure_ascii=False, indent=2))
            os.replace(stage, os.path.join(self.root, "inbox", tid))
            self.c.progress(tid, 0.0, "delivered to exchange inbox")
            self.log(f"pulled {tid}: {t.get('title')}" + (f" [{ws}]" if ws else ""))
            delivered += 1
        return delivered

    def _outputs(self, d):
        files = []
        for n in sorted(os.listdir(d), key=_upload_order):
            p = os.path.join(d, n)
            if n == "result.json" or n.endswith(".tmp") or n.startswith("."):
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
                sent += 1
        return sent

    def renew(self):
        for tid in os.listdir(os.path.join(self.root, "working")):
            try:
                self.c.progress(tid, None, "working")
            except HubError as e:
                if e.status in (404, 409):
                    self.log(f"{tid} no longer leased ({e.code})")

    def tick(self):
        self.heartbeat("idle")
        pushed = self.push()
        self.renew()
        pulled = self.pull()
        return pulled, pushed


class Runner:
    """`run`: stay online. First heartbeat with back-off (5 s doubling to 60 s), then a heartbeat
    every `heartbeat_seconds` and long polls in between (each poll is cut to the next heartbeat).
    Network / 5xx errors back off the same way; 401 / 403 (token revoked) stop the loop."""

    def __init__(self, bridge, heartbeat_seconds=DEFAULT_HEARTBEAT, wait=DEFAULT_WAIT, log=print,
                 sleep=time.sleep, clock=time.monotonic):
        self.b, self.every, self.wait, self.log, self.sleep, self.clock = bridge, heartbeat_seconds, wait, log, sleep, clock
        self.next_heartbeat = 0.0
        self.backoff = 5
        self.heartbeats = 0

    @staticmethod
    def fatal(err):
        return isinstance(err, HubError) and err.status in (401, 403)

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
    s.add_argument("--worker-dir", help="worker folder with .env / profile.json (default <DSH home>/worker, DSH home = $DSH_HOME or ~/.dsh)")
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
    if st["no_proxy"] and is_public_host(u.hostname):
        warn(f"DSH_HUB_PROXY=off but {u.hostname} is public: the server only accepts outside traffic; use the proxy")
    return HubClient(url, token, a.insecure, st["cafile"], a.timeout, agent_id=agent_id or st["agent_id"] or None,
                     proxy=st["proxy"], no_proxy=st["no_proxy"], workspaces=workspaces)


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
        out(f"warning: DSH_HUB_PROXY=off but {u.hostname} is a public address: the server only accepts traffic from "
            "outside, so MYDESK must reach it through the proxy (DSH_HUB_PROXY=http://127.0.0.1:7890)")

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
# dsh-hub worker settings of this machine: <DSH home>/worker/.env (keep it private: chmod 600).
# Priority: command line > process environment > this file > profile.json > default.
# Relative paths are relative to this folder. Reference: python agent_client.py --help

# Hub address: host, host:port or URL (default port 7891, path /v1)
DSH_HUB_URL=https://hub.example.com:7891
# Way out to the hub: http://host:port = HTTP proxy (MYDESK: Clash/mihomo 7890), off = direct, env = HTTPS_PROXY / system proxy
DSH_HUB_PROXY=http://127.0.0.1:7890
# CA file (PEM) when the hub certificate is self-signed; empty = system CAs
DSH_HUB_CAFILE=
# Registered worker name, ^[a-z][a-z0-9-]{1,47}$, suggested <agent>-<machine>
DSH_AGENT_ID=quick-mydesk
DSH_NODE=mydesk
# aws-quick | claude-code | kiro | custom
DSH_PLATFORM=aws-quick
# Comma separated capabilities, for pool:<capability> tasks
DSH_CAPABILITIES=code,document
DSH_MAX_CONCURRENCY=1
# Written by `register` (mode 600); the token is only ever read from this file
DSH_AGENT_TOKEN_FILE=agent.token
# Exchange folder of run / bridge (inbox, working, outbox, failed, archive)
DSH_EXCHANGE=E:/dsh-exchange
# Heartbeat period of `run` in seconds (the hub marks a worker offline after 90 s of silence)
DSH_HEARTBEAT_SECONDS=30
"""


def profile_template(node=None):
    return {"node": node or default_node(), "dshProfile": None, "workspaces": {}}


def cmd_init(worker_dir, node=None, out=print):
    os.makedirs(worker_dir, exist_ok=True)
    done = {}
    env_path = os.path.join(worker_dir, ".env")
    if os.path.exists(env_path):
        done[".env"] = "kept (already exists)"
    else:
        write_atomic(env_path, ENV_TEMPLATE)
        _private(env_path)
        done[".env"] = "created"
    prof = os.path.join(worker_dir, "profile.json")
    legacy = os.path.join(worker_dir, "workspaces.json")
    if os.path.exists(prof):
        done["profile.json"] = "kept (already exists)"
    else:
        write_atomic(prof, json.dumps(profile_template(node), indent=2) + "\n")
        done["profile.json"] = "created" + (" (a legacy workspaces.json is next to it: copy its workspaces over)" if os.path.isfile(legacy) else "")
    out(f"worker dir: {worker_dir}")
    for name, what in done.items():
        out(f"  {name:<13} {what}")
    out("next:")
    out("  1. edit .env: DSH_HUB_URL, DSH_AGENT_ID, DSH_NODE, DSH_PLATFORM, DSH_CAPABILITIES, DSH_EXCHANGE;")
    out("     DSH_HUB_PROXY=http://127.0.0.1:7890 on MYDESK (the server only accepts outside traffic)")
    out("  2. edit profile.json: workspaces {name: local path} (names as in router-b), or dshProfile")
    out("  3. python agent_client.py check      (reachable through the proxy? which IP does the hub see?)")
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

    i = sub.add_parser("init", help="write .env and profile.json templates into the worker dir (never overwrites)", epilog=epilog, formatter_class=fmt)
    i.add_argument("--worker-dir", help="worker folder (default <DSH home>/worker)")
    i.add_argument("--node", help="node name for profile.json (default: host name)")
    add("workspaces", "print the local workspace map and file settings, then exit (no network)", net=False)
    c = add("check", "GET /v1/health through the configured proxy and report (no token)", worker=False)
    c.set_defaults(timeout=15)
    e = add("register", "ask the hub to register this worker, wait for approval, save the token", aliases=("enroll",))
    e.add_argument("--platform", help="overrides DSH_PLATFORM (default custom)")
    e.add_argument("--mode", choices=["poll", "push"], default="poll")
    e.add_argument("--capabilities", help="comma separated; overrides DSH_CAPABILITIES")
    e.add_argument("--max-concurrency", type=int, help="overrides DSH_MAX_CONCURRENCY (default 1)")
    e.add_argument("--description", default="")
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
    b.add_argument("--interval", type=int, default=60)
    b.add_argument("--max", type=int, default=1)
    b.add_argument("--wait", type=int, default=DEFAULT_WAIT, help=f"long-poll seconds (0..{MAX_WAIT}, default {DEFAULT_WAIT})")
    return p


def main(argv=None, env=None):
    p = build_parser()
    a = p.parse_args(argv)
    env = os.environ if env is None else env
    cmd = "register" if a.cmd == "enroll" else a.cmd
    try:
        wd = os.path.abspath(os.path.expanduser(a.worker_dir)) if a.worker_dir else default_worker_dir(env)
        if cmd == "init":
            return cmd_init(wd, a.node)
        dotenv = read_env_file(os.path.join(wd, ".env"))
        wm = resolve_workspaces(a.profile_file, a.node, required=a.profile_file is not None, worker_dir=wd)
        cli = {k: getattr(a, k, None) for k in ("cafile", "agent_id", "node", "platform", "capabilities",
                                                "max_concurrency", "exchange", "heartbeat_seconds")}
        st = resolve_settings(wm, getattr(a, "url", None), getattr(a, "token_file", None), getattr(a, "proxy", None),
                              getattr(a, "no_proxy", False), env=env, dotenv=dotenv, worker_dir=wd, cli=cli)
        wm.node = st["node"]
        if cmd == "workspaces":
            out = wm.to_json()
            out["settings"] = settings_summary(st)
            print(json.dumps(out, ensure_ascii=False, indent=2))
            return 0
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
    br = Bridge(client, exchange, max_tasks, workspaces=wm.workspaces, node=wm.node, wait=a.wait)
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
