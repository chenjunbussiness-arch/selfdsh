"""Unit tests for scripts/agent_client.py (dsh-agent/2.0 worker client). Stdlib only.

    python -m unittest discover -s plugins/dsh-agent-hub/scripts/tests -v

No network: HTTP goes through a fake opener, the bridge talks to a fake HubClient,
file-system tests use throw-away folders (DSH_TEST_TMP overrides the base dir).
"""
import argparse, base64, contextlib, copy, io, json, os, shutil, socket, ssl, tempfile, unittest, urllib.error, urllib.parse, urllib.request, uuid

try:
    agent_client  # noqa: F821 -- an exec-based runner may inject the module
except NameError:
    import sys
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import agent_client

ac = agent_client
try:
    REPO = os.environ.get("DSH_REPO") or os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", ".."))
except NameError:
    REPO = os.environ.get("DSH_REPO", "")


def mkdtemp():
    # os.makedirs, not tempfile.mkdtemp: mkdtemp's mode 0o700 becomes a user-only ACL on
    # Windows (Python >= 3.12.4), which sandboxed runners cannot write into.
    base = os.environ.get("DSH_TEST_TMP") or tempfile.gettempdir()
    path = os.path.join(base, "dsh-ac-" + uuid.uuid4().hex[:12])
    os.makedirs(path)
    return path


class Logs(list):
    def __call__(self, message):
        self.append(message)

    def joined(self):
        return "\n".join(self)


# --- samples copied from the repo ------------------------------------------------------

# plugins/dsh-router-b/cordis.patch.yml (bundle layer: `- insert:` list, quoted root with a
# space, `>-` descriptions, nested exclude / keywords lists).
ROUTER_B_SNIPPET = """\
# Partition roots must be absolute.
- insert:
    - id: host-router
      name: dsh-host-router
      config:
        manager: true
        # 0 = no router-side worker cap.
        maxWorkers: 0
        autoVerify: false
        partitions:
          - name: rca-ab-test
            root: /srv/workspace/rca-ab-test
            description: >-
              RCA 根因分析平台（运维故障根因定位）。单仓库三个服务：rca-front（React + Vite 前端：运维台、
              原子库工作台、编排编辑器、路由页面），rca-state（Go/Kratos 控制面与 MCP server），
              rca-openjiuwen-agent（Python/FastAPI + openjiuwen 的 agent 角色与提示词）。
            exclude:
              - '**/node_modules/**'
              - '**/vendor/**'
              - '**/.venv/**'
              - '**/.git/**'
            keywords:
              - rca
              - 前端
              - mcp
            workers: 0
          - name: google-tend
            root: "/srv/workspace/google tend"
            description: >-
              个人小项目集合：工具站与 SEO（ai-tool-business 隐私优先浏览器本地工具站、parasite-seo、
              passport-photo-rules 护照/签证照片规格、bgr-demo 护照照片制作、cloud-cutout 抠图），
              prompt-lab、moli-eval、Open-Anti-Browser-main、tools（kiro-relay 等）。
            exclude:
              - '**/node_modules/**'
              - '**/.git/**'
            keywords:
              - google
              - seo
            workers: 0
          - name: deepseek-harness
            root: /srv/workspace/deepseek-harness
            description: >-
              DeepSeek Harness（DSH）插件源码：dsh-router-b（分区路由插件 host-router + 路由面板 client-ui-router），
              dsh-vpn（openfortivpn VPN 管理插件 host-vpn + client-ui-vpn 页面）。
            exclude:
              - '**/node_modules/**'
            keywords:
              - dsh
              - 插件
            workers: 0
    - id: client-ui-router
      name: dsh-client-ui-router
"""

# profile/cordis.patch.yml (profile layer: top-level `- id:` entries, quoted names, nested
# `- id:` / `name:` model lists). The real profile has no host-router entry.
PROFILE_SNIPPET = """\
# Your patch layer for this dsh profile, applied after every bundle layer:
- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-09-28.1

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      commandecode:
        displayName: commandecode
        apiKeyEnv: DEEPSEEK_API_KEY
        api: openai-completions
        baseURL: https://api.commandcode.ai/provider/v1
        models:
          - id: deepseek/deepseek-v4.1-flash
            name: DSV4.1
            input:
              - text
              - image
            reasoningEfforts:
              off: null
              low: low
- id: subagent
  name: '@deepseek-ai/dsh-subagent'
  config:
    maxActiveSubagents: 64
- id: mcp-manager
  name: '@deepseek-ai/dsh-mcp-manager'
  inject: [ credentials ]
  config:
    servers:
      exa-stdio:
        transport: stdio
        command: node
        args:
          - /srv/workspace/deepseek-harness/vendor/exa-mcp-server/dist/stdio.cjs
        env:
          EXA_API_KEY: '${credential:EXA_API_KEY}'
        enabled: false
"""

# A host-router override written the way the profile writes its entries (top-level
# `- id:`, quoted name), with a compact sequence, mixed quoting, comments and decoys.
PROFILE_OVERRIDE = """\
- id: locale
  name: "@deepseek-ai/dsh-client-locale"
  config:
    preference: zh
# 本机分区（覆盖 bundle）
- id: host-router
  name: dsh-host-router
  config:
    manager: true
    partitions:
    - name: deepseek-harness   # 主仓库
      root: 'E:/PythonProject/dsh-warroom'
      description: >-
        多行描述，里面的假条目不应被识别：
        - name: fake-in-folded
          root: /fake/folded
    - name: "google tend"
      root: "C:/Users/me/google tend"
      notes: |
        root: /fake/literal
        - name: fake-in-literal
    -
      name: bare-dash
      root: D:/work/bare dash
    - name: no-root
    - root: /nameless
- id: other-plugin
  name: dsh-other
  config:
    partitions:
      - name: not-a-router-partition
        root: /elsewhere
"""


class TestYamlScalar(unittest.TestCase):
    def test_scalars(self):
        s = ac.yaml_scalar
        self.assertEqual(s('"/srv/workspace/google tend"'), "/srv/workspace/google tend")
        self.assertEqual(s("'/srv/it''s here'  # c"), "/srv/it's here")
        self.assertEqual(s("/srv/plain path   # comment"), "/srv/plain path")
        self.assertEqual(s('"E:\\\\work\\\\a"'), "E:\\work\\a")
        self.assertEqual(s('"E:\\PythonProject"'), "E:\\PythonProject")  # unknown escape kept
        self.assertEqual(s('"\\u4e2d"'), "中")
        for empty in ("", "   ", "~", "null", "# only a comment"):
            self.assertIsNone(s(empty))
        with self.assertRaises(ValueError):
            s('"unterminated')
        with self.assertRaises(ValueError):
            s('"a" junk')


class TestPartitions(unittest.TestCase):
    def test_router_b_bundle_layer(self):
        logs = Logs()
        got = ac.parse_partitions(ROUTER_B_SNIPPET, logs)
        self.assertEqual(got, [
            {"name": "rca-ab-test", "root": "/srv/workspace/rca-ab-test"},
            {"name": "google-tend", "root": "/srv/workspace/google tend"},
            {"name": "deepseek-harness", "root": "/srv/workspace/deepseek-harness"},
        ])
        self.assertEqual(logs, [])

    def test_profile_without_router_entry(self):
        self.assertEqual(ac.parse_partitions(PROFILE_SNIPPET, Logs()), [])

    def test_profile_style_override(self):
        logs = Logs()
        got = {p["name"]: p["root"] for p in ac.parse_partitions(PROFILE_OVERRIDE, logs)}
        self.assertEqual(got, {
            "deepseek-harness": "E:/PythonProject/dsh-warroom",
            "google tend": "C:/Users/me/google tend",
            "bare-dash": "D:/work/bare dash",
            "no-root": None,
        })
        # block scalars skipped, other plugins' partitions ignored, nameless item warned
        for decoy in ("fake-in-folded", "fake-in-literal", "not-a-router-partition"):
            self.assertNotIn(decoy, got)
        self.assertIn("without a name", logs.joined())

    def test_unowned_list_and_later_wins(self):
        text = "partitions:\n  - name: a\n    root: /one\n  - name: b\n    root: /b\n  - name: a\n    root: /two\n"
        self.assertEqual(ac.parse_partitions(text, Logs()), [{"name": "b", "root": "/b"}, {"name": "a", "root": "/two"}])

    def test_broken_and_flow_style(self):
        logs = Logs()
        text = '- id: host-router\n  config:\n    partitions:\n      - name: ok\n        root: /ok\n      - name: bad\n        root: "/unterminated\n'
        self.assertEqual(ac.parse_partitions(text, logs), [{"name": "ok", "root": "/ok"}])
        self.assertIn("unterminated", logs.joined())
        logs = Logs()
        self.assertEqual(ac.parse_partitions("- id: host-router\n  config:\n    partitions: [{name: a, root: /a}]\n", logs), [])
        self.assertIn("flow-style", logs.joined())
        self.assertEqual(ac.parse_partitions("- id: host-router\n  config:\n    partitions: []\n", Logs()), [])

    def test_real_repo_files(self):
        rb = os.path.join(REPO, "plugins", "dsh-router-b", "cordis.patch.yml")
        prof = os.path.join(REPO, "profile", "cordis.patch.yml")
        if not (os.path.isfile(rb) and os.path.isfile(prof)):
            self.skipTest("repo files not found")
        with open(rb, encoding="utf-8") as f:
            names = [p["name"] for p in ac.parse_partitions(f.read(), Logs())]
        self.assertEqual(names, ["rca-ab-test", "google-tend", "deepseek-harness"])
        with open(prof, encoding="utf-8") as f:
            self.assertEqual(ac.parse_partitions(f.read(), Logs()), [])


class TempCase(unittest.TestCase):
    def setUp(self):
        self.tmp = mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, *parts, make=False):
        p = os.path.join(self.tmp, *parts)
        if make:
            os.makedirs(p, exist_ok=True)
        return p

    def write(self, rel, text):
        p = self.path(rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p


class TestResolveWorkspaces(TempCase):
    def setUp(self):
        super().setUp()
        self.ws_a = self.path("repos", "a", make=True)
        self.ws_space = self.path("repos", "google tend", make=True)
        self.ws_override = self.path("repos", "override", make=True)
        q = lambda p: p.replace("\\", "/")
        self.patch = self.write("profile/cordis.patch.yml", (
            "- id: host-router\n  name: dsh-host-router\n  config:\n    partitions:\n"
            f"      - name: alpha\n        root: {q(self.ws_a)}\n"
            "        description: >-\n          text: with colon\n"
            f"      - name: google-tend\n        root: \"{q(self.ws_space)}\"\n"
            "      - name: harness\n        root: /definitely/not/here/dsh\n"
            "      - name: hidden\n        root: " + q(self.ws_a) + "\n"
            "      - name: relative\n        root: some/relative\n"))

    def config(self, **body):
        body.setdefault("profile", self.path("profile"))
        return self.write("worker/workspaces.json", json.dumps(body))

    def test_priority_merge(self):
        logs = Logs()
        cfg = self.config(node="mydesk", workspaces={"harness": self.ws_override, "extra": "../repos/a", "hidden": None})
        wm = ac.resolve_workspaces(cfg, log=logs)
        self.assertEqual(wm.node, "mydesk")
        self.assertEqual(wm.workspaces, {
            "alpha": os.path.abspath(self.ws_a),
            "google-tend": os.path.abspath(self.ws_space),
            "harness": os.path.abspath(self.ws_override),      # explicit beats profile
            "extra": os.path.abspath(self.ws_a),               # relative to workspaces.json
        })
        self.assertEqual(wm.sources["harness"], "workspaces.json")
        self.assertEqual(wm.sources["alpha"], "profile")
        self.assertEqual(wm.names(), ["alpha", "extra", "google-tend", "harness"])
        reasons = {d["name"]: d["reason"] for d in wm.dropped}
        self.assertEqual(reasons, {"relative": "root not absolute", "hidden": "hidden by workspaces.json"})

    def test_missing_paths_dropped_with_warning(self):
        logs = Logs()
        cfg = self.config(workspaces={"ghost": self.path("nope")})
        wm = ac.resolve_workspaces(cfg, log=logs)
        self.assertNotIn("harness", wm.workspaces)
        self.assertNotIn("ghost", wm.workspaces)
        self.assertEqual({d["name"] for d in wm.dropped if d["reason"] == "path does not exist"}, {"harness", "ghost"})
        self.assertIn("workspace harness: path does not exist", logs.joined())
        self.assertIn("workspace ghost: path does not exist", logs.joined())

    def test_explicit_missing_does_not_fall_back_to_profile(self):
        wm = ac.resolve_workspaces(self.config(workspaces={"alpha": self.path("gone")}), log=Logs())
        self.assertNotIn("alpha", wm.workspaces)

    def test_names_follow_the_disk(self):
        wm = ac.resolve_workspaces(self.config(), log=Logs())
        self.assertIn("alpha", wm.names())
        shutil.rmtree(self.ws_a)
        self.assertNotIn("alpha", wm.names())

    def test_profile_may_name_the_file_and_node_precedence(self):
        cfg = self.config(profile=self.patch, node="from-file")
        wm = ac.resolve_workspaces(cfg, log=Logs())
        self.assertIn("google-tend", wm.workspaces)
        self.assertEqual(ac.resolve_workspaces(cfg, node="cli", log=Logs()).node, "cli")
        cfg2 = self.write("w2/workspaces.json", json.dumps({"workspaces": {}}))
        self.assertEqual(ac.resolve_workspaces(cfg2, log=Logs()).node, ac.default_node())

    def test_missing_file(self):
        logs = Logs()
        wm = ac.resolve_workspaces(self.path("none.json"), log=logs)
        self.assertEqual(wm.workspaces, {})
        self.assertIn("no profile at", logs.joined())
        with self.assertRaises(ac.ConfigError):
            ac.resolve_workspaces(self.path("none.json"), required=True, log=logs)
        bad = self.write("bad.json", "{not json")
        with self.assertRaises(ac.ConfigError):
            ac.resolve_workspaces(bad, log=logs)

    def test_example_file_parses(self):
        example = os.path.join(REPO, "plugins", "dsh-agent-hub", "scripts", "workspaces.example.json")
        if not os.path.isfile(example):
            self.skipTest("example not found")
        with open(example, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(set(data), {"node", "profile", "workspaces", "hubUrl", "tokenFile", "proxy"})
        cfg = self.write("ex/workspaces.json", json.dumps(dict(data, profile=self.path("profile"),
                                                             workspaces={"deepseek-harness": self.ws_a, "rca-ab-test": None})))
        wm = ac.resolve_workspaces(cfg, log=Logs())
        self.assertEqual(wm.node, "mydesk")
        self.assertEqual(wm.proxy, "http://127.0.0.1:7890")  # MYDESK reaches the hub through Clash/mihomo
        self.assertEqual(wm.token_file, os.path.abspath(os.path.expanduser("~/.dsh/worker/quick-mydesk.token")))
        self.assertIn("deepseek-harness", wm.workspaces)

    def test_file_settings_and_precedence(self):
        cfg = self.config(hubUrl="file-hub", tokenFile="tokens/w.token", proxy="127.0.0.1:7890")
        wm = ac.resolve_workspaces(cfg, log=Logs())
        self.assertEqual(wm.token_file, os.path.abspath(self.path("worker", "tokens", "w.token")))  # relative to the file
        self.assertEqual(wm.proxy, "http://127.0.0.1:7890")
        env = {"DSH_HUB_URL": "env-hub", "DSH_AGENT_TOKEN": "dsha_x_y"}
        wd = self.path("wd", make=True)
        st = ac.resolve_settings(wm, env={}, worker_dir=wd)  # profile fields are the lowest-priority fallback
        self.assertEqual((st["url"], st["token_file"], st["proxy"], st["no_proxy"]), ("file-hub", wm.token_file, "http://127.0.0.1:7890", False))
        self.assertEqual((st["sources"]["url"], st["sources"]["token_file"], st["sources"]["proxy"]), ("profile", "profile", "profile"))
        st = ac.resolve_settings(wm, env=env, worker_dir=wd)
        self.assertEqual((st["url"], st["sources"]["url"]), ("env-hub", "env"))  # the environment beats profile.json
        st = ac.resolve_settings(wm, url="cli-hub", token_file="~/cli.token", proxy="http://10.0.0.1:3128", env=env, worker_dir=wd)
        self.assertEqual((st["url"], st["proxy"]), ("cli-hub", "http://10.0.0.1:3128"))
        self.assertEqual(st["token_file"], os.path.abspath(os.path.expanduser("~/cli.token")))
        self.assertEqual(ac.resolve_settings(wm, no_proxy=True, env=env, worker_dir=wd)["proxy"], None)
        self.assertIs(ac.resolve_settings(wm, no_proxy=True, env=env, worker_dir=wd)["no_proxy"], True)
        bare = ac.resolve_workspaces(self.config(), log=Logs())
        st = ac.resolve_settings(bare, env=env, worker_dir=wd)
        self.assertEqual(st["url"], "env-hub")
        self.assertEqual(st["token_file"], os.path.join(wd, "agent.token"))  # default: agent.token in the worker dir
        self.assertNotIn("dsha_x_y", json.dumps(st))                           # the environment never supplies the token
        self.assertEqual((st["proxy"], st["no_proxy"]), (None, False))        # default: env / system proxy
        direct = ac.resolve_workspaces(self.config(proxy=False), log=Logs())
        self.assertEqual(ac.resolve_settings(direct, env={}, worker_dir=wd)["no_proxy"], True)
        self.assertEqual(ac.resolve_settings(direct, proxy="http://p:1", env={}, worker_dir=wd)["proxy"], "http://p:1")

    def test_bad_file_settings(self):
        for body in ({"hubUrl": 5}, {"tokenFile": ""}, {"proxy": True}, {"proxy": "socks5://h:1"}, {"workspaces": []}):
            with self.assertRaises(ac.ConfigError, msg=str(body)):
                ac.resolve_workspaces(self.write("bad/workspaces.json", json.dumps(body)), log=Logs())

    def test_missing_url_or_token_file_is_a_config_error(self):
        wm = ac.resolve_workspaces(self.config(), log=Logs())
        wd = self.path("wd", make=True)
        with self.assertRaises(ac.ConfigError) as cm:
            ac.check_settings(ac.resolve_settings(wm, token_file="t", env={}, worker_dir=wd))
        self.assertIn("DSH_HUB_URL", str(cm.exception))
        ac.check_settings(ac.resolve_settings(wm, token_file="t", env={"DSH_HUB_URL": "h"}, worker_dir=wd))
        with contextlib.redirect_stderr(io.StringIO()):
            code = ac.main(["bridge", "--exchange", self.path("ex"), "--workspaces-file", self.config(), "--url", "h",
                            "--worker-dir", wd], env={})
        self.assertEqual(code, 2)  # no token file yet: a local error, before any network or exchange folder
        self.assertFalse(os.path.exists(self.path("ex")))
        with contextlib.redirect_stderr(io.StringIO()):
            code = ac.main(["run", "--worker-dir", wd, "--workspaces-file", self.config()], env={})
        self.assertEqual(code, 2)  # no DSH_HUB_URL anywhere: config error

    def test_token_is_read_from_file_and_not_printed(self):
        tf = self.write("secret/w.token", "dsha_quick-mydesk_SECRET123\n")
        self.assertEqual(ac.read_token(tf), "dsha_quick-mydesk_SECRET123")
        cfg = self.config(tokenFile=tf, hubUrl="h")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            ac.main(["workspaces", "--workspaces-file", cfg, "--worker-dir", self.path("wd")], env={})
        self.assertNotIn("SECRET123", out.getvalue())
        self.assertEqual(json.loads(out.getvalue())["file_settings"]["tokenFile"], os.path.abspath(tf))
        with self.assertRaises(ac.ConfigError):
            ac.read_token(self.write("secret/empty.token", "\n"))

    def test_help_documents_every_key(self):
        parser = ac.build_parser()
        text = parser.format_help()
        subs = next(x for x in parser._actions if isinstance(x, argparse._SubParsersAction)).choices
        for sub in ("init", "check", "register", "enroll", "run", "status", "leave", "bridge", "workspaces"):
            self.assertIn(sub, subs)
            self.assertIn("DSH_HUB_PROXY", subs[sub].format_help())
        for key in ("node", "dshProfile", "workspaces", "hubUrl", "tokenFile", "proxy", "~/.dsh/worker/workspaces.json",
                    "profile.json", ".env", "<DSH home>/worker", "7891", "http://127.0.0.1:7890") + ac.ENV_KEYS:
            self.assertIn(key, text)
        self.assertIn("--url", text)

    def test_workspaces_command_prints_map_offline(self):
        cfg = self.config(node="mydesk")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            code = ac.main(["workspaces", "--workspaces-file", cfg, "--worker-dir", self.path("wd")], env={})
        self.assertEqual(code, 0)
        data = json.loads(out.getvalue())
        self.assertEqual(data["node"], "mydesk")
        self.assertIn("google-tend", data["workspaces"])


# --- HTTP layer --------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, body):
        self.body = body

    def read(self):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    def __init__(self, *responses):
        self.requests, self.responses = [], list(responses)

    def open(self, req, timeout=None):
        self.requests.append((req, timeout))
        r = self.responses.pop(0) if self.responses else b"{}"
        if isinstance(r, Exception):
            raise r
        return FakeResponse(r if isinstance(r, bytes) else json.dumps(r).encode())


TOKEN = "dsha_quick-mydesk_" + "x" * 32


def split(req):
    u = urllib.parse.urlsplit(req.full_url)
    return u.scheme + "://" + u.netloc + u.path, urllib.parse.parse_qsl(u.query)


class TestUrls(unittest.TestCase):
    def test_hub_url_defaults(self):
        self.assertEqual(ac.hub_url("hub.example.com"), "https://hub.example.com:7891/v1")
        self.assertEqual(ac.hub_url("1.2.3.4"), "https://1.2.3.4:7891/v1")
        self.assertEqual(ac.hub_url("https://hub.example.com/"), "https://hub.example.com:7891/v1")
        self.assertEqual(ac.hub_url("https://hub:8443"), "https://hub:8443/v1")
        self.assertEqual(ac.hub_url("http://127.0.0.1:7891/v1/"), "http://127.0.0.1:7891/v1")
        self.assertEqual(ac.DEFAULT_PORT, 7891)
        self.assertEqual(ac.hub_url("[::1]"), "https://[::1]:7891/v1")
        for bad in ("", "ftp://x", "https://h/v1?token=1", "https://u:p@h", "https://h:99999"):
            with self.assertRaises(ac.ConfigError):
                ac.hub_url(bad)

    def client(self, *responses, **kw):
        opener = FakeOpener(*responses)
        kw.setdefault("workspaces", ["deepseek-harness"])
        return ac.HubClient("hub.example.com", kw.pop("token", TOKEN), opener=opener, **kw), opener

    def test_url_for_puts_id_first_and_no_token(self):
        c, _ = self.client()
        self.assertEqual(c.agent_id, "quick-mydesk")
        url = c.url_for("artifact", {"task_id": "t 1", "name": "a&b.md", "from_task": None})
        self.assertEqual(url, "https://hub.example.com:7891/v1/artifact?id=quick-mydesk&task_id=t+1&name=a%26b.md")
        self.assertNotIn("dsha_", url)

    def test_heartbeat_sends_names_and_header_token(self):
        c, op = self.client({"ok": True})
        c.heartbeat("idle")
        req, _ = op.requests[0]
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(split(req), ("https://hub.example.com:7891/v1/heartbeat", [("id", "quick-mydesk")]))
        self.assertEqual(req.get_header("X-dsh-token"), TOKEN)
        self.assertEqual(req.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(req.data), {"status": "idle", "workspaces": ["deepseek-harness"], "client_version": ac.CLIENT_VERSION})
        self.assertNotIn(TOKEN, req.full_url)

    def test_poll_is_a_long_get(self):
        c, op = self.client({"tasks": [{"task_id": "t1"}]}, {"tasks": []}, timeout=30)
        self.assertEqual(c.poll(2, 25), [{"task_id": "t1"}])
        req, timeout = op.requests[0]
        self.assertEqual(req.get_method(), "GET")
        self.assertIsNone(req.data)
        self.assertEqual(split(req), ("https://hub.example.com:7891/v1/poll", [("id", "quick-mydesk"), ("max", "2"), ("wait", "25")]))
        self.assertGreater(timeout, 25)
        c.poll(1, 600)
        req, timeout = op.requests[1]
        self.assertIn(("wait", "55"), split(req)[1])
        self.assertGreater(timeout, 55)

    def test_event_result_artifact(self):
        c, op = self.client({"ok": True}, {"ok": True}, b"bytes")
        c.progress("t1", 0.5, "half")
        c.result("t1", "failed", "s", [], {"code": "X", "message": "m", "retryable": False})
        self.assertEqual(c.artifact("t1", "in.md", "up"), b"bytes")
        paths = [split(r) for r, _ in op.requests]
        self.assertEqual(paths[0], ("https://hub.example.com:7891/v1/event", [("id", "quick-mydesk")]))
        self.assertEqual(paths[1][0], "https://hub.example.com:7891/v1/result")
        self.assertEqual(json.loads(op.requests[1][0].data)["error"]["code"], "X")
        self.assertEqual(paths[2], ("https://hub.example.com:7891/v1/artifact",
                                    [("id", "quick-mydesk"), ("task_id", "t1"), ("name", "in.md"), ("from_task", "up")]))

    def test_enroll_has_no_token_and_carries_node_and_names(self):
        c, op = self.client({"request_id": "req_1", "poll_secret": "s", "status": "pending"}, {"status": "pending"},
                            token=None, agent_id="kiro-mydesk")
        c.enroll_request("aws-quick", "poll", "mydesk", ["deepseek-harness"], ["code"], 2, "desc")
        c.enroll_status("req_1", "s")
        for req, _ in op.requests:
            self.assertIsNone(req.get_header("X-dsh-token"))
            self.assertEqual(split(req)[1], [("id", "kiro-mydesk")])
        self.assertEqual(split(op.requests[1][0])[0], "https://hub.example.com:7891/v1/enroll/status")
        body = json.loads(op.requests[0][0].data)
        self.assertEqual(body, {"platform": "aws-quick", "mode": "poll", "node": "mydesk", "workspaces": ["deepseek-harness"],
                                "capabilities": ["code"], "max_concurrency": 2, "description": "desc"})

    def test_enroll_flow_saves_token(self):
        tmp = mkdtemp()
        try:
            c, op = self.client({"request_id": "req_1", "poll_secret": "s", "status": "pending"},
                                {"status": "approved", "agent_id": "kiro-mydesk", "token": "dsha_kiro-mydesk_abc"},
                                token=None, agent_id="kiro-mydesk")
            tf = os.path.join(tmp, "kiro.token")
            logs = Logs()
            self.assertEqual(ac.enroll(c, "custom", "poll", "mydesk", ["w"], [], 1, "", tf, tf + ".enroll.json", True, 0, logs), 0)
            with open(tf, encoding="utf-8") as f:
                self.assertEqual(f.read().strip(), "dsha_kiro-mydesk_abc")
            self.assertFalse(os.path.exists(tf + ".enroll.json"))
            self.assertNotIn("dsha_", logs.joined())
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_http_errors_become_hub_errors(self):
        err = urllib.error.HTTPError("https://x", 401, "Unauthorized", {}, io.BytesIO(b'{"error":{"code":"unauthorized","message":"bad"}}'))
        c, _ = self.client(err)
        with self.assertRaises(ac.HubError) as cm:
            c.heartbeat()
        self.assertEqual((cm.exception.status, cm.exception.code), (401, "unauthorized"))

    def test_agent_id_rules(self):
        with self.assertRaises(ac.ConfigError):
            ac.HubClient("h", TOKEN, agent_id="someone-else", opener=FakeOpener())
        with self.assertRaises(ac.ConfigError):
            ac.HubClient("h", None, opener=FakeOpener())
        with self.assertRaises(ac.ConfigError):
            ac.HubClient("h", None, agent_id="Bad_Id", opener=FakeOpener())
        c, _ = self.client(token=None, agent_id="quick-mydesk")
        with self.assertRaises(ac.ConfigError):
            c.heartbeat()


class TestProxy(unittest.TestCase):
    URL = "https://hub.example.com:7891/v1"

    def test_notice(self):
        env = {"https": "http://user:secret@127.0.0.1:7890"}
        note = ac.proxy_notice(self.URL, env_proxies=env, bypass=lambda h: False)
        self.assertIn("--no-proxy", note)
        self.assertIn("127.0.0.1:7890", note)
        self.assertNotIn("secret", note)
        self.assertIsNone(ac.proxy_notice(self.URL, env_proxies=env, bypass=lambda h: True))
        self.assertIsNone(ac.proxy_notice(self.URL, env_proxies={}, bypass=lambda h: False))
        self.assertIsNone(ac.proxy_notice(self.URL, no_proxy=True, env_proxies=env))
        self.assertIn("--proxy", ac.proxy_notice(self.URL, proxy="http://127.0.0.1:7890", env_proxies={}))

    def test_opener_handlers(self):
        ctx = ac.make_ssl_context()
        self.assertEqual(ac.proxy_handler(no_proxy=True).proxies, {})
        self.assertEqual(ac.proxy_handler(proxy="http://127.0.0.1:7890").proxies,
                         {"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"})
        self.assertIsNone(ac.proxy_handler())  # urllib default: env + system proxies
        # An empty ProxyHandler opens nothing itself, but it stops urllib adding the env-reading one.
        direct = ac.build_opener(ctx, no_proxy=True)
        self.assertFalse(any(isinstance(h, urllib.request.ProxyHandler) and h.proxies for h in direct.handlers))
        via = ac.build_opener(ctx, proxy="http://127.0.0.1:7890")
        self.assertEqual([h.proxies for h in via.handlers if isinstance(h, urllib.request.ProxyHandler)],
                         [{"http": "http://127.0.0.1:7890", "https": "http://127.0.0.1:7890"}])
        self.assertEqual(ac.normalize_proxy("127.0.0.1:7890"), "http://127.0.0.1:7890")
        with self.assertRaises(ac.ConfigError):
            ac.normalize_proxy("socks5://127.0.0.1:7891")


# --- bridge ---------------------------------------------------------------------------------

class FakeHub:
    agent_id = "quick-mydesk"

    def __init__(self, tasks=(), artifacts=None, result_error=None):
        self.calls, self.tasks, self.artifacts, self.result_error = [], list(tasks), dict(artifacts or {}), result_error

    abort_ids = ()

    def heartbeat(self, status="idle", workspaces=None, running=None):
        self.calls.append(("heartbeat", status, list(workspaces or [])))
        self.running_seen = None if running is None else list(running)
        return {"ok": True, "abort": list(self.abort_ids)}

    def poll(self, max_tasks=1, wait=25):
        self.calls.append(("poll", max_tasks, wait))
        out, self.tasks = self.tasks[:max_tasks], self.tasks[max_tasks:]
        return copy.deepcopy(out)

    def progress(self, task_id, progress=None, message=None):
        self.calls.append(("progress", task_id, progress, message))
        return {"ok": True}

    def artifact(self, task_id, name, from_task=None):
        self.calls.append(("artifact", task_id, name, from_task))
        return self.artifacts[(from_task or task_id, name)]

    def result(self, task_id, status, summary="", files=(), error=None, needs_input=None):
        self.calls.append(("result", task_id, status, summary, list(files), error, needs_input))
        if self.result_error:
            raise self.result_error
        return {"ok": True}

    def of(self, kind):
        return [c for c in self.calls if c[0] == kind]


def task(tid, **extra):
    t = {"protocol": "dsh-agent/2.0", "task_id": tid, "type": "code", "title": f"T {tid}", "instruction": "do", "inputs": []}
    t.update(extra)
    return t


class TestBridge(TempCase):
    def setUp(self):
        super().setUp()
        self.ws = self.path("repos", "dsh warroom", make=True)
        self.ex = self.path("exchange")
        self.logs = Logs()

    def bridge(self, hub, **kw):
        kw.setdefault("workspaces", {"deepseek-harness": self.ws})
        return ac.Bridge(hub, self.ex, kw.pop("max_tasks", 2), log=self.logs, node="mydesk", wait=kw.pop("wait", 5), **kw)

    def test_workspace_missing_fails_fast(self):
        hub = FakeHub([task("t1", workspace="ghost", inputs=[{"name": "in.md", "from_task": "t1"}])])
        br = self.bridge(hub)
        self.assertEqual(br.pull(), 0)
        (call,) = hub.of("result")
        self.assertEqual(call[1:3], ("t1", "failed"))
        self.assertEqual(call[5]["code"], "WORKSPACE_MISSING")
        self.assertIs(call[5]["retryable"], False)
        self.assertEqual(os.listdir(os.path.join(self.ex, "inbox")), [])
        self.assertEqual(hub.of("artifact"), [])
        self.assertEqual(hub.of("progress"), [])
        self.assertEqual(br.rejected, 1)
        self.assertIn(("poll", 2, 5), hub.calls)

    def test_workspace_gone_after_start_is_missing_too(self):
        hub = FakeHub([task("t1", workspace="deepseek-harness")])
        br = self.bridge(hub)
        shutil.rmtree(self.ws)
        br.pull()
        self.assertEqual(hub.of("result")[0][5]["code"], "WORKSPACE_MISSING")

    def test_missing_refused_by_hub_is_logged(self):
        hub = FakeHub([task("t1", workspace="ghost")], result_error=ac.HubError(409, "task-not-active", "x"))
        self.assertEqual(self.bridge(hub).pull(), 0)
        self.assertIn("task-not-active", self.logs.joined())

    def test_task_json_gets_workspace_path_and_node(self):
        hub = FakeHub([task("t1", workspace="deepseek-harness", ref="main", inputs=[{"name": "in.md", "from_task": "t1"}]),
                       task("t2", type="research")], artifacts={("t1", "in.md"): b"hello"})
        br = self.bridge(hub)
        self.assertEqual(br.pull(), 2)
        with open(os.path.join(self.ex, "inbox", "t1", "task.json"), encoding="utf-8") as f:
            t1 = json.load(f)
        self.assertEqual(t1["workspace_path"], self.ws)
        self.assertEqual(t1["workspace_host_path"], self.ws, "no DSH_PATH_MAP: host path = local path")
        self.assertEqual(t1["node"], "mydesk")
        self.assertEqual(t1["ref"], "main")
        self.assertEqual(t1["exchange"]["result_dir"], "outbox/t1")
        with open(os.path.join(self.ex, "inbox", "t1", "in.md"), "rb") as f:
            self.assertEqual(f.read(), b"hello")
        with open(os.path.join(self.ex, "inbox", "t2", "task.json"), encoding="utf-8") as f:
            t2 = json.load(f)
        self.assertIsNone(t2["workspace_path"])
        self.assertIsNone(t2["workspace_host_path"])
        self.assertEqual(t2["node"], "mydesk")
        br2 = ac.Bridge(FakeHub([task("t3", workspace="deepseek-harness")]), self.path("ex2"), 1, log=Logs(), node="mydesk",
                        workspaces={"deepseek-harness": self.ws}, host_paths={"deepseek-harness": "E:/PythonProject/dsh-warroom"}, wait=5)
        br2.pull()
        with open(os.path.join(self.path("ex2"), "inbox", "t3", "task.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["workspace_host_path"], "E:/PythonProject/dsh-warroom")
        self.assertEqual([c[1] for c in hub.of("progress")], ["t1", "t2"])
        self.assertEqual(hub.of("result"), [])
        self.assertFalse(any(n.endswith(".part") for n in os.listdir(os.path.join(self.ex, "inbox"))))

    def test_heartbeat_reports_existing_names_only(self):
        hub = FakeHub()
        br = self.bridge(hub, workspaces={"deepseek-harness": self.ws, "gone": self.path("gone")})
        br.tick()
        self.assertEqual(hub.of("heartbeat")[0], ("heartbeat", "idle", ["deepseek-harness"]))
        for call in hub.of("heartbeat"):
            self.assertFalse(any(os.sep in n or "/" in n for n in call[2]))

    def test_full_inbox_sends_busy_and_skips_poll(self):
        hub = FakeHub([task("t1")])
        br = self.bridge(hub, max_tasks=1)
        os.makedirs(os.path.join(self.ex, "working", "t0"))
        self.assertEqual(br.pull(), 0)
        self.assertEqual(hub.of("heartbeat")[-1][1], "busy")
        self.assertEqual(hub.of("poll"), [])

    def test_push_outbox_conventions(self):
        hub = FakeHub()
        br = self.bridge(hub)
        d = self.path("exchange", "outbox", "t1", make=True)
        for name, text in (("notes.txt", "n"), ("summary.md", "## done\nall good"), ("changes.patch", "diff --git a/x b/x\n"),
                           ("bad!name.txt", "x"), (".hidden", "x"), ("part.tmp", "x")):
            with open(os.path.join(d, name), "w", encoding="utf-8", newline="") as f:  # keep LF on Windows
                f.write(text)
        os.makedirs(os.path.join(d, "subdir"))
        os.makedirs(os.path.join(self.ex, "working", "t1"))
        self.assertEqual(br.push(), 0)  # no result.json yet: nothing uploaded
        with open(os.path.join(d, "result.json"), "w", encoding="utf-8") as f:
            f.write('{"status": "completed"')  # half-written
        self.assertEqual(br.push(), 0)
        self.assertIn("not complete", self.logs.joined())
        with open(os.path.join(d, "result.json"), "w", encoding="utf-8") as f:
            json.dump({"status": "completed"}, f)
        self.assertEqual(br.push(), 1)
        (call,) = hub.of("result")
        names = [f["name"] for f in call[4]]
        self.assertEqual(names, ["changes.patch", "summary.md", "notes.txt"])
        self.assertEqual(call[3], "## done\nall good")  # summary falls back to summary.md
        self.assertEqual(base64.b64decode(call[4][0]["base64"]), b"diff --git a/x b/x\n")
        self.assertTrue(os.path.isdir(os.path.join(self.ex, "archive", "t1")))
        self.assertFalse(os.path.exists(d))
        self.assertFalse(os.path.exists(os.path.join(self.ex, "working", "t1")))

    def test_push_failed_box_and_explicit_summary(self):
        hub = FakeHub()
        br = self.bridge(hub)
        d = self.path("exchange", "failed", "t9", make=True)
        with open(os.path.join(d, "summary.md"), "w", encoding="utf-8") as f:
            f.write("long")
        with open(os.path.join(d, "result.json"), "w", encoding="utf-8") as f:
            json.dump({"summary": "short", "error": {"code": "TESTS_FAILED", "message": "m", "retryable": True}}, f)
        self.assertEqual(br.push(), 1)
        call = hub.of("result")[0]
        self.assertEqual(call[1:4], ("t9", "failed", "short"))
        self.assertEqual(call[5]["code"], "TESTS_FAILED")

# --- worker dir: .env, profile.json, priorities ---------------------------------------------

class TestBridgeAfterAbort(TempCase):
    """A scheduled worker the hub once told to abort must keep pulling and take a re-leased task again."""

    def setUp(self):
        super().setUp()
        self.ex = self.path("exchange")

    def bridge(self, hub, max_tasks=1):
        return ac.Bridge(hub, self.ex, max_tasks, log=Logs(), node="mydesk", wait=0)

    def test_an_aborted_copy_in_working_does_not_take_a_slot(self):
        hub = FakeHub([task("t1", type="research")])
        br = self.bridge(hub)
        os.makedirs(os.path.join(self.ex, "working", "t0"))
        br.abort(["t0"])
        self.assertEqual(br.pull(), 1)
        self.assertTrue(os.path.isdir(os.path.join(self.ex, "inbox", "t1")))

    def test_a_task_only_in_archive_is_delivered_again(self):
        hub = FakeHub([task("t1", type="research")])
        br = self.bridge(hub)
        os.makedirs(os.path.join(self.ex, "outbox", "t1"))
        br.abort(["t1"])
        self.assertTrue(os.path.isdir(os.path.join(self.ex, "archive", "t1")))
        self.assertEqual(br.pull(), 1)
        self.assertTrue(os.path.isdir(os.path.join(self.ex, "inbox", "t1")))
        self.assertTrue(any(n.startswith("t1.prev-") for n in os.listdir(os.path.join(self.ex, "archive"))))

    def test_an_aborted_working_copy_handed_back_is_unmarked_not_duplicated(self):
        hub = FakeHub([task("t1", type="research")])
        br = self.bridge(hub, max_tasks=2)
        os.makedirs(os.path.join(self.ex, "working", "t1"))
        br.abort(["t1"])
        self.assertEqual(br.pull(), 0)
        self.assertFalse(os.path.exists(os.path.join(self.ex, "working", "t1", ac.ABORT_MARK)))
        self.assertFalse(os.path.exists(os.path.join(self.ex, "inbox", "t1")))
        self.assertEqual(br.running_ids(), ["t1"])


class TestScheduleSettings(TempCase):
    def test_role_and_schedule_go_to_enroll_and_heartbeat(self):
        sent = []

        class Spy(ac.HubClient):
            def _req(self, method, path, body=None, **kw):
                sent.append((path, body))
                return {}

        c = Spy("https://hub.example:7891", None, agent_id="quick-mydesk", role="tester", pull_every_seconds=900)
        c.enroll_request("aws-quick", "poll", "mydesk", [], ["report"], 1, "")
        c.token = "dsha_quick-mydesk_x"
        c.heartbeat("idle", [], running=[])
        self.assertEqual((sent[0][1]["role"], sent[0][1]["pull_every_seconds"]), ("tester", 900))
        self.assertEqual(sent[1][1]["pull_every_seconds"], 900)
        plain = Spy("https://hub.example:7891", None, agent_id="quick-mydesk")
        plain.heartbeat("idle", [])
        self.assertNotIn("pull_every_seconds", sent[2][1])

    def test_settings_validate_role_and_schedule(self):
        wm = ac.resolve_workspaces(None, "mydesk", worker_dir=self.path("w", make=True))
        st = ac.resolve_settings(wm, env={"DSH_ROLE": "tester", "DSH_PULL_EVERY_SECONDS": "900"}, worker_dir=self.path("w"))
        self.assertEqual((st["role"], st["pull_every_seconds"]), ("tester", 900))
        st = ac.resolve_settings(wm, env={}, worker_dir=self.path("w"))
        self.assertEqual((st["role"], st["pull_every_seconds"]), ("worker", None))
        with self.assertRaises(ac.ConfigError):
            ac.resolve_settings(wm, env={"DSH_ROLE": "boss"}, worker_dir=self.path("w"))
        with self.assertRaises(ac.ConfigError):
            ac.resolve_settings(wm, env={"DSH_PULL_EVERY_SECONDS": "10"}, worker_dir=self.path("w"))


class TestMachineProfile(TempCase):
    def test_capabilities_parse_with_limits(self):
        self.assertEqual(ac.parse_capabilities("browser:1, test,code,test"), ["browser:1", "test", "code"])
        self.assertEqual(ac.parse_capabilities({"browser": 1, "test": None}), ["browser:1", "test"])
        self.assertEqual(ac.parse_capabilities(None), [])
        for bad in ("Browser", "browser:0", "browser:33", {"browser": "x"}, 7):
            with self.assertRaises(ac.ConfigError):
                ac.parse_capabilities(bad)

    def test_each_machine_profile_says_what_its_worker_does(self):
        w = self.path("w", make=True)
        ws = self.path("repo", make=True)
        prof = os.path.join(w, "profile.json")
        with open(prof, "w", encoding="utf-8") as f:
            json.dump({"node": "mydesk", "agentId": "dsh-mydesk", "platform": "dsh", "workspaces": {"deepseek-harness": ws},
                       "capabilities": {"browser": 1, "test": None, "code": 2}, "maxConcurrency": 4, "role": "worker",
                       "pullEverySeconds": 600}, f)
        wm = ac.resolve_workspaces(prof, None, worker_dir=w)
        st = ac.resolve_settings(wm, env={}, worker_dir=w)
        self.assertEqual((st["agent_id"], st["platform"], st["capabilities"], st["max_concurrency"], st["pull_every_seconds"]),
                         ("dsh-mydesk", "dsh", ["browser:1", "test", "code:2"], 4, 600))
        self.assertEqual(st["sources"]["capabilities"], "profile")
        st = ac.resolve_settings(wm, env={"DSH_CAPABILITIES": "code"}, worker_dir=w)
        self.assertEqual(st["capabilities"], ["code"], "the environment still wins over the profile")
        with self.assertRaises(ac.ConfigError):
            ac.resolve_settings(wm, env={"DSH_CAPABILITIES": "Code"}, worker_dir=w)

    def test_local_dsh_example_is_valid(self):
        example = os.path.join(REPO, "plugins", "dsh-agent-hub", "scripts", "agent.local-dsh.example.json")
        with open(example, encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual(ac.machine_settings(cfg, example)["capabilities"], ["browser:1", "test:2", "code:2"])


class TestEnvFile(TempCase):
    def test_parse_rules_match_the_plugin(self):
        text = ("\ufeff# comment\r\nDSH_HUB_URL=https://h:7891\r\nexport DSH_AGENT_ID=\"quick-mydesk\"\n"
                "DSH_HUB_PROXY=http://127.0.0.1:7890   # Clash\nDSH_PLATFORM='aws quick' # c\nBROKEN=\"open\n"
                "1BAD=x\nnoequals\nDSH_NODE=first\nDSH_NODE=second\nDSH_HUB_CAFILE=\nHASH=a#b\n")
        env = ac.parse_env_text(text)
        self.assertEqual(env, {"DSH_HUB_URL": "https://h:7891", "DSH_AGENT_ID": "quick-mydesk", "DSH_HUB_PROXY": "http://127.0.0.1:7890",
                               "DSH_PLATFORM": "aws quick", "DSH_NODE": "second", "DSH_HUB_CAFILE": "", "HASH": "a#b"})

    def test_read_env_file_warns_on_loose_permissions_except_windows(self):
        path = self.write("w/.env", "DSH_NODE=x\n")
        os.chmod(path, 0o644)
        logs = Logs()
        self.assertEqual(ac.read_env_file(path, logs, platform="linux"), {"DSH_NODE": "x"})
        if os.stat(path).st_mode & 0o077:
            self.assertIn("chmod 600", logs.joined())
        logs = Logs()
        ac.read_env_file(path, logs, platform="win32")
        self.assertEqual(logs, [])
        self.assertEqual(ac.read_env_file(self.path("none/.env"), logs), {})

    def test_examples_match_the_templates(self):
        scripts = os.path.join(REPO, "plugins", "dsh-agent-hub", "scripts")
        env_example = os.path.join(scripts, "worker.env.example")
        agent_example = os.path.join(scripts, "agent.example.json")
        if not (os.path.isfile(env_example) and os.path.isfile(agent_example)):
            self.skipTest("examples not found")
        with open(env_example, encoding="utf-8") as f:
            text = f.read()
        self.assertEqual(text, ac.ENV_TEMPLATE, "worker.env.example is what `init` writes")
        self.assertEqual(tuple(ac.parse_env_text(text)), ac.ENV_KEYS)
        values = ac.parse_env_text(text)
        self.assertEqual((values["DSH_HUB_PROXY"], values["DSH_HUB_URL"]), ("off", ""))
        with open(agent_example, encoding="utf-8") as f:
            self.assertEqual(set(json.load(f)), set(ac.agent_template("x")))


class TestRuntime(TempCase):
    def settings(self, profile=None, platform="aws-quick"):
        wd = self.path("wd-" + uuid.uuid4().hex[:6], make=True)
        if profile is not None:
            with open(os.path.join(wd, "profile.json"), "w", encoding="utf-8") as f:
                json.dump(profile, f)
        wm = ac.resolve_workspaces(worker_dir=wd, log=Logs())
        return ac.resolve_settings(wm, env={}, dotenv={"DSH_PLATFORM": platform}, worker_dir=wd)

    def test_platform_default_profile_override_and_null(self):
        st = self.settings()
        self.assertEqual(st["runtime"]["modes"], ["fast", "balanced", "smart"])
        self.assertEqual(st["runtime"]["defaults"]["code"], {"mode": "smart", "thinking": "medium"})
        st["runtime"]["modes"].append("x")
        self.assertEqual(ac.PLATFORM_RUNTIMES["aws-quick"]["modes"], ["fast", "balanced", "smart"], "a copy, not the table")
        self.assertIsNone(self.settings(platform="custom")["runtime"], "other platforms declare nothing")
        mine = {"modes": ["fast"], "agents": [{"name": "quick", "description": "default"}]}
        self.assertEqual(self.settings({"runtime": mine})["runtime"], mine)
        self.assertIsNone(self.settings({"runtime": None})["runtime"], "null = declare nothing")
        self.assertEqual(ac.settings_summary(self.settings({"runtime": mine}))["runtime"], mine)
        for bad in ({"modes": ["turbo"]}, {"thinking": "high"}, {"agents": [1]}, {"default": {"mode": "x"}}, {"defaults": []}):
            with self.assertRaises(ac.ConfigError, msg=json.dumps(bad)):
                self.settings({"runtime": bad})
        with self.assertRaises(ac.ConfigError):
            self.settings({"runtime": ["fast"]})

    def test_enroll_and_heartbeat_carry_the_runtime(self):
        rt = {"modes": ["fast", "smart"]}
        op = FakeOpener({"request_id": "r", "poll_secret": "s"}, {"ok": True})
        c = ac.HubClient("hub.example.com", TOKEN, opener=op, workspaces=["w"], runtime=rt)
        c.enroll_request("aws-quick", "poll", "mydesk", ["w"], [], 1, "")
        c.heartbeat("idle")
        self.assertEqual(json.loads(op.requests[0][0].data)["runtime"], rt)
        self.assertEqual(json.loads(op.requests[1][0].data)["runtime"], rt)
        op2 = FakeOpener({"ok": True})
        ac.HubClient("hub.example.com", TOKEN, opener=op2).heartbeat("idle")
        self.assertNotIn("runtime", json.loads(op2.requests[0][0].data), "nothing declared -> key not sent")

    def test_resolve_effort(self):
        rt = ac.platform_runtime("aws-quick")
        self.assertEqual(ac.resolve_effort({"type": "code"}, rt), {"mode": "smart", "thinking": "medium", "source": "default"})
        self.assertEqual(ac.resolve_effort({"type": "document"}, rt), {"mode": "balanced", "thinking": "low", "source": "default"})
        self.assertEqual(ac.resolve_effort({"type": "code", "effort": {"mode": "fast"}}, rt), {"mode": "fast", "source": "task"},
                         "another mode does not inherit the default's thinking")
        self.assertEqual(ac.resolve_effort({"type": "code", "effort": {"thinking": "high"}}, rt), {"mode": "smart", "thinking": "high", "source": "task"})
        self.assertEqual(ac.resolve_effort({"type": "data", "context": {"effort": {"mode": "smart", "agent": "quick"}}}, rt),
                         {"mode": "smart", "agent": "quick", "source": "task"}, "context.effort from an older hub")
        self.assertEqual(ac.resolve_effort({"type": "code", "effort": {"mode": "smart"}}, None), {"mode": "smart", "source": "task"})
        self.assertEqual(ac.resolve_effort({"type": "code"}, None), {"source": "none"})

    def test_bridge_writes_effort_resolved(self):
        hub = FakeHub([task("t1", type="document"), task("t2", type="research", effort={"mode": "smart", "thinking": "high"})])
        hub.runtime = ac.platform_runtime("aws-quick")
        ex = self.path("ex-rt")
        ac.Bridge(hub, ex, 5, log=Logs(), node="mydesk", wait=5).pull()
        with open(os.path.join(ex, "inbox", "t1", "task.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["effort_resolved"], {"mode": "balanced", "thinking": "low", "source": "default"})
        with open(os.path.join(ex, "inbox", "t2", "task.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f)["effort_resolved"], {"mode": "smart", "thinking": "high", "source": "task"})


class TestPathMap(TempCase):
    def test_parse_and_map(self):
        pm = ac.parse_path_map(r"E:/=/host/e; C:\Users\me\.dsh\profiles\desktop=/host/dsh-profile ;")
        self.assertEqual(pm, [("C:/Users/me/.dsh/profiles/desktop", "/host/dsh-profile"), ("E:", "/host/e")])
        self.assertEqual(ac.map_path("e:\\PythonProject\\x", pm), "/host/e/PythonProject/x")
        self.assertEqual(ac.map_path("E:/", pm), "/host/e/")
        self.assertEqual(ac.map_path("c:/users/ME/.dsh/profiles/desktop/cordis.patch.yml", pm), "/host/dsh-profile/cordis.patch.yml")
        self.assertEqual(ac.map_path("D:/other", pm), "D:/other")
        self.assertEqual(ac.map_path("E:/x", []), "E:/x")
        self.assertEqual(ac.parse_path_map(""), [])
        for bad in ("E:/", "=/x", "E:/="):
            with self.assertRaises(ac.ConfigError):
                ac.parse_path_map(bad)
        self.assertEqual(ac.map_path("/srv/a", ac.parse_path_map("/srv=/mnt")), "/mnt/a")
        self.assertEqual(ac.map_path("/SRV/a", ac.parse_path_map("/srv=/mnt")), "/SRV/a", "POSIX prefixes stay case-sensitive")

    def test_host_profile_read_through_the_map(self):
        local = self.path("host-e", "Proj", "ws", make=True)
        wd = self.path("wd", make=True)
        with open(os.path.join(wd, "profile.json"), "w", encoding="utf-8") as f:
            json.dump({"node": "mydesk", "workspaces": {"ws": "E:\\Proj\\ws", "gone": "E:/Proj/missing"}}, f)
        logs = Logs()
        wm = ac.resolve_workspaces(worker_dir=wd, log=logs, path_map=ac.parse_path_map("E:/=" + self.path("host-e")))
        self.assertEqual(wm.names(), ["ws"])
        self.assertEqual(wm.workspaces["ws"], os.path.abspath(local))
        self.assertEqual(wm.host_paths["ws"], "E:\\Proj\\ws")
        self.assertIn("gone", logs.joined())
        self.assertEqual(wm.to_json()["host_paths"], {"ws": "E:\\Proj\\ws"})
        plain = ac.resolve_workspaces(worker_dir=wd, log=Logs())
        if os.name != "nt":
            self.assertEqual(plain.names(), [], "without the map the Windows paths do not exist here")

    def test_main_reads_dsh_path_map(self):
        self.path("host-e", "Proj", "ws", make=True)
        wd = self.path("wd2", make=True)
        with open(os.path.join(wd, "profile.json"), "w", encoding="utf-8") as f:
            json.dump({"workspaces": {"ws": "E:/Proj/ws"}}, f)
        with open(os.path.join(wd, ".env"), "w", encoding="utf-8") as f:
            f.write("DSH_PATH_MAP=E:/=" + self.path("host-e").replace("\\", "/") + "\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(ac.main(["workspaces", "--worker-dir", wd], env={}), 0)
        self.assertIn("ws", json.loads(out.getvalue())["workspaces"])


class TestWorkerDir(TempCase):
    def setUp(self):
        super().setUp()
        self.wd = self.path("home", ".dsh", "worker", make=True)
        self.repo = self.path("repo", make=True)

    def settings(self, env=None, dotenv=None, **kw):
        wm = ac.resolve_workspaces(worker_dir=self.wd, log=Logs())
        return ac.resolve_settings(wm, env=env or {}, dotenv=dotenv, worker_dir=self.wd, **kw), wm

    def test_default_worker_dir_follows_dsh_home(self):
        self.assertEqual(ac.default_worker_dir({"DSH_HOME": self.path("h")}), os.path.join(self.path("h"), "worker"))
        self.assertEqual(ac.default_worker_dir({}), os.path.join(os.path.abspath(os.path.expanduser("~")), ".dsh", "worker"))

    def test_profile_json_wins_over_legacy_workspaces_json(self):
        with open(os.path.join(self.wd, "workspaces.json"), "w", encoding="utf-8") as f:
            json.dump({"node": "legacy", "workspaces": {"old": self.repo}, "hubUrl": "legacy-hub"}, f)
        logs = Logs()
        wm = ac.resolve_workspaces(worker_dir=self.wd, log=logs)
        self.assertTrue(wm.legacy)
        self.assertEqual((wm.node, wm.hub_url, list(wm.workspaces)), ("legacy", "legacy-hub", ["old"]))
        self.assertIn("rename it to profile.json", logs.joined())
        with open(os.path.join(self.wd, "profile.json"), "w", encoding="utf-8") as f:
            json.dump({"node": "mydesk", "workspaces": {"deepseek-harness": self.repo}}, f)
        logs = Logs()
        wm = ac.resolve_workspaces(worker_dir=self.wd, log=logs)
        self.assertFalse(wm.legacy)
        self.assertEqual((wm.node, list(wm.workspaces), wm.hub_url), ("mydesk", ["deepseek-harness"], None))
        self.assertEqual(logs, [])

    def test_dsh_profile_key_reads_router_b_partitions(self):
        patch = self.write("prof/cordis.patch.yml", "- id: host-router\n  config:\n    partitions:\n"
                           f"      - name: rb\n        root: {self.repo.replace(os.sep, '/')}\n")
        with open(os.path.join(self.wd, "profile.json"), "w", encoding="utf-8") as f:
            json.dump({"dshProfile": os.path.dirname(patch)}, f)
        wm = ac.resolve_workspaces(worker_dir=self.wd, log=Logs())
        self.assertEqual(wm.workspaces, {"rb": os.path.abspath(self.repo)})

    def test_priority_cli_env_dotenv_profile_default(self):
        with open(os.path.join(self.wd, "profile.json"), "w", encoding="utf-8") as f:
            json.dump({"node": "from-profile", "hubUrl": "profile-hub", "tokenFile": "p.token", "proxy": False}, f)
        dotenv = {"DSH_HUB_URL": "dotenv-hub", "DSH_NODE": "from-dotenv", "DSH_HUB_PROXY": "http://127.0.0.1:7890",
                  "DSH_AGENT_TOKEN_FILE": "agent.token", "DSH_EXCHANGE": "ex", "DSH_HUB_CAFILE": "ca.pem",
                  "DSH_CAPABILITIES": "code, document", "DSH_MAX_CONCURRENCY": "2", "DSH_PLATFORM": "aws-quick",
                  "DSH_AGENT_ID": "quick-mydesk", "DSH_HEARTBEAT_SECONDS": "20"}
        st, _ = self.settings(dotenv=dotenv)
        self.assertEqual(st["url"], "dotenv-hub")
        self.assertEqual(st["node"], "from-dotenv")
        self.assertEqual((st["proxy"], st["no_proxy"]), ("http://127.0.0.1:7890", False))
        self.assertEqual(st["token_file"], os.path.join(self.wd, "agent.token"))   # relative to the worker dir
        self.assertEqual(st["exchange"], os.path.join(self.wd, "ex"))
        self.assertEqual(st["cafile"], os.path.join(self.wd, "ca.pem"))
        self.assertEqual((st["capabilities"], st["max_concurrency"], st["heartbeat_seconds"]), (["code", "document"], 2, 20))
        self.assertEqual((st["platform"], st["agent_id"]), ("aws-quick", "quick-mydesk"))
        self.assertEqual(st["sources"]["url"], ".env")
        st, _ = self.settings(env={"DSH_HUB_URL": "env-hub", "DSH_HUB_PROXY": "off", "DSH_NODE": "from-env"}, dotenv=dotenv)
        self.assertEqual((st["url"], st["node"], st["no_proxy"], st["sources"]["url"]), ("env-hub", "from-env", True, "env"))
        st, _ = self.settings(env={"DSH_HUB_URL": "env-hub"}, dotenv=dotenv, url="cli-hub", proxy="env",
                              cli={"node": "from-cli", "max_concurrency": 3})
        self.assertEqual((st["url"], st["node"], st["proxy"], st["no_proxy"], st["max_concurrency"]), ("cli-hub", "from-cli", None, False, 3))
        st, _ = self.settings()  # nothing but the profile
        self.assertEqual((st["url"], st["node"], st["no_proxy"]), ("profile-hub", "from-profile", True))
        self.assertEqual(st["token_file"], os.path.join(self.wd, "p.token"))
        os.remove(os.path.join(self.wd, "profile.json"))
        st, _ = self.settings()  # defaults
        self.assertEqual((st["url"], st["proxy"], st["no_proxy"], st["platform"], st["max_concurrency"], st["heartbeat_seconds"]),
                         (None, None, False, "custom", 1, 30))
        self.assertEqual(st["node"], ac.default_node())
        self.assertEqual((st["token_file"], st["exchange"]), (os.path.join(self.wd, "agent.token"), os.path.join(self.wd, "exchange")))

    def test_bad_values_are_config_errors(self):
        for dotenv in ({"DSH_MAX_CONCURRENCY": "lots"}, {"DSH_MAX_CONCURRENCY": "0"}, {"DSH_HEARTBEAT_SECONDS": "1"},
                       {"DSH_HUB_PROXY": "socks5://127.0.0.1:7891"}, {"DSH_AGENT_ID": "Quick_Mydesk"}):
            with self.assertRaises(ac.ConfigError, msg=str(dotenv)):
                self.settings(dotenv=dotenv)

    def test_summary_masks_proxy_and_never_holds_the_token(self):
        tf = os.path.join(self.wd, "agent.token")
        with open(tf, "w", encoding="utf-8") as f:
            f.write(TOKEN)
        st, _ = self.settings(dotenv={"DSH_HUB_PROXY": "http://user:pw-secret@127.0.0.1:7890"})
        summary = ac.settings_summary(st)
        self.assertEqual(summary["proxy"], "http://***@127.0.0.1:7890")
        self.assertTrue(summary["token_file_exists"])
        self.assertNotIn(TOKEN, json.dumps(summary))
        self.assertNotIn("pw-secret", json.dumps(summary))

    def test_init_writes_templates_once_and_prints_next_steps(self):
        out = Logs()
        self.assertEqual(ac.cmd_init(self.wd, "mydesk", out, agent="code-mydesk", profile="web"), 0)
        with open(os.path.join(self.wd, ".env"), encoding="utf-8") as f:
            self.assertEqual(f.read(), ac.ENV_TEMPLATE)
        with open(os.path.join(self.wd, "agents", "code-mydesk.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertEqual((cfg["agentId"], cfg["dshProfile"], cfg["node"]), ("code-mydesk", "web", "mydesk"))
        self.assertTrue(os.path.isdir(os.path.join(self.wd, "tokens")))
        self.assertIn("doctor", out.joined())
        self.assertIn("register", out.joined())
        with open(os.path.join(self.wd, ".env"), "w", encoding="utf-8") as f:
            f.write("DSH_HUB_URL=mine\n")
        out = Logs()
        ac.cmd_init(self.wd, "mydesk", out, agent="code-mydesk")
        with open(os.path.join(self.wd, ".env"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "DSH_HUB_URL=mine\n", "never overwritten")
        self.assertIn("kept", out.joined())
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ac.main(["init", "--worker-dir", self.path("fresh"), "--agent", "a1"], env={}), 0)
        self.assertTrue(os.path.isfile(self.path("fresh", ".env")))
        self.assertTrue(os.path.isfile(self.path("fresh", "exchange", "a1", "README.md")))

    def test_init_without_an_agent_only_writes_env(self):
        out = Logs()
        self.assertEqual(ac.cmd_init(self.wd, "mydesk", out, exchange=True, env={}), 0)
        self.assertEqual(os.listdir(self.wd), [".env"])
        self.assertIn("init --agent", out.joined())

    def test_init_creates_the_exchange_folder_with_a_readme(self):
        ex = self.path("ex")
        out = Logs()
        self.assertEqual(ac.cmd_init(self.wd, "mydesk", out, exchange=True, env={}, exchange_dir=ex, agent="a1"), 0)
        for d in ac.EXCHANGE_DIRS:
            self.assertTrue(os.path.isdir(os.path.join(ex, d)), d)
        with open(os.path.join(ex, "README.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), ac.EXCHANGE_README)
        self.assertIn("created", out.joined())
        with open(os.path.join(ex, "README.md"), "w", encoding="utf-8") as f:
            f.write("mine")
        out = Logs()
        ac.cmd_init(self.wd, "mydesk", out, exchange=True, env={}, exchange_dir=ex, agent="a1")
        with open(os.path.join(ex, "README.md"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "mine", "README.md is never overwritten")
        self.assertIn("kept", out.joined())

    def test_bridge_creates_the_exchange_readme(self):
        ex = self.path("bridge-ex")
        ac.ensure_exchange(ex)
        self.assertEqual(sorted(os.listdir(ex)), sorted(list(ac.EXCHANGE_DIRS) + ["README.md"]))
        self.assertEqual(ac.ensure_exchange(ex), [])

    def test_main_reads_worker_env(self):
        with open(os.path.join(self.wd, ".env"), "w", encoding="utf-8") as f:
            f.write("DSH_NODE=from-dotenv\nDSH_HUB_URL=hub.example.com\n")
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            ac.main(["workspaces", "--worker-dir", self.wd], env={"DSH_NODE": "from-env"})
        data = json.loads(out.getvalue())
        self.assertEqual(data["node"], "from-env")
        self.assertEqual(data["settings"]["hub_url"], "hub.example.com")


# --- register / status / leave ---------------------------------------------------------------

def http_error(status, code, extra=None):
    body = {"error": dict({"code": code, "message": code}, **(extra or {}))}
    return urllib.error.HTTPError("https://x", status, code, {}, io.BytesIO(json.dumps(body).encode()))


class TestCommands(TempCase):
    def setUp(self):
        super().setUp()
        self.wd = self.path("worker", make=True)
        self.repo = self.path("repo", make=True)
        with open(os.path.join(self.wd, "profile.json"), "w", encoding="utf-8") as f:
            json.dump({"node": "mydesk", "workspaces": {"deepseek-harness": self.repo}}, f)
        self.wm = ac.resolve_workspaces(worker_dir=self.wd, log=Logs())
        self.st = ac.resolve_settings(self.wm, env={}, worker_dir=self.wd,
                                      dotenv={"DSH_HUB_URL": "hub.example.com", "DSH_AGENT_ID": "quick-mydesk",
                                              "DSH_PLATFORM": "aws-quick", "DSH_CAPABILITIES": "code,document"})
        self.openers = []

    def make(self, *responses):
        def factory(token, agent_id=None):
            op = FakeOpener(*responses)
            self.openers.append(op)
            return ac.HubClient("hub.example.com", token, agent_id=agent_id or self.st["agent_id"], opener=op, workspaces=self.wm.names())
        return factory

    def args(self, **kw):
        return argparse.Namespace(**dict({"mode": "poll", "description": "", "no_wait": False, "interval": 0}, **kw))

    def test_register_enrolls_with_node_platform_capabilities_and_names(self):
        logs = Logs()
        code = ac.cmd_register(self.st, self.wm, self.make({"request_id": "req_1", "poll_secret": "s", "status": "pending"},
                                                           {"status": "approved", "agent_id": "quick-mydesk", "token": TOKEN}), self.args(), logs)
        self.assertEqual(code, 0)
        req = self.openers[0].requests[0][0]
        self.assertEqual(split(req), ("https://hub.example.com:7891/v1/enroll", [("id", "quick-mydesk")]))
        self.assertEqual(json.loads(req.data), {"platform": "aws-quick", "mode": "poll", "node": "mydesk", "workspaces": ["deepseek-harness"],
                                                "capabilities": ["code", "document"], "max_concurrency": 1, "description": ""})
        with open(self.st["token_file"], encoding="utf-8") as f:
            self.assertEqual(f.read().strip(), TOKEN)
        self.assertNotIn(TOKEN, logs.joined())

    def test_register_when_already_registered_does_nothing(self):
        with open(self.st["token_file"], "w", encoding="utf-8") as f:
            f.write(TOKEN)
        logs = Logs()
        self.assertEqual(ac.cmd_register(self.st, self.wm, self.make({"agent_id": "quick-mydesk", "status": "online"}), self.args(), logs), 0)
        self.assertEqual(len(self.openers), 1)
        self.assertEqual(split(self.openers[0].requests[0][0])[0], "https://hub.example.com:7891/v1/me")
        self.assertIn("already registered", logs.joined())

    def test_register_with_a_rejected_token_moves_it_aside_and_asks_again(self):
        with open(self.st["token_file"], "w", encoding="utf-8") as f:
            f.write(TOKEN)
        factory_calls = []
        responses = [[http_error(401, "unauthorized")],
                     [{"request_id": "req_2", "poll_secret": "s", "status": "pending"}, {"status": "pending"}]]
        def factory(token, agent_id=None):
            factory_calls.append(token)
            op = FakeOpener(*responses[len(factory_calls) - 1])
            self.openers.append(op)
            return ac.HubClient("hub.example.com", token, agent_id="quick-mydesk", opener=op)
        logs = Logs()
        self.assertEqual(ac.cmd_register(self.st, self.wm, factory, self.args(no_wait=True), logs), 2)  # still pending
        self.assertEqual(factory_calls, [TOKEN, None])
        self.assertTrue(os.path.isfile(self.st["token_file"] + ".rejected"))
        self.assertFalse(os.path.exists(self.st["token_file"]))
        self.assertTrue(os.path.isfile(self.st["token_file"] + ".enroll.json"), "resumable")
        self.assertIn("401", logs.joined())

    def test_register_needs_an_agent_id(self):
        st = dict(self.st, agent_id=None)
        with self.assertRaises(ac.ConfigError):
            ac.cmd_register(st, self.wm, self.make(), self.args(), Logs())

    def test_status_shows_settings_and_the_hubs_view_without_the_token(self):
        out = Logs()
        self.assertEqual(ac.cmd_status(self.st, self.wm, self.make(), out), 0)
        report = json.loads(out.joined())
        self.assertIn("not registered", report["hub"]["skipped"])
        with open(self.st["token_file"], "w", encoding="utf-8") as f:
            f.write(TOKEN)
        me = {"agent_id": "quick-mydesk", "status": "online", "workspaces": ["deepseek-harness"], "ignored_workspaces": [],
              "running_tasks": ["t1"], "client_ip": "203.0.113.9"}
        out = Logs()
        self.assertEqual(ac.cmd_status(self.st, self.wm, self.make(me), out), 0)
        report = json.loads(out.joined())
        self.assertEqual(report["hub"], me)
        self.assertEqual(report["settings"]["node"], "mydesk")
        self.assertEqual(report["sources"]["url"], ".env")
        self.assertNotIn(TOKEN, out.joined())
        self.assertEqual(self.openers[-1].requests[0][0].get_header("X-dsh-token"), TOKEN)
        out = Logs()
        self.assertEqual(ac.cmd_status(self.st, self.wm, self.make(http_error(401, "unauthorized")), out), 1)
        self.assertIn("401", json.loads(out.joined())["hub"]["error"])

    def test_me_and_leave_calls(self):
        op = FakeOpener({"status": "online"}, {"ok": True, "status": "left", "requeued": ["t1"]})
        c = ac.HubClient("hub.example.com", TOKEN, opener=op)
        c.me()
        self.assertEqual(c.leave("going home")["requeued"], ["t1"])
        (me, _), (leave, _) = op.requests
        self.assertEqual((me.get_method(), split(me)), ("GET", ("https://hub.example.com:7891/v1/me", [("id", "quick-mydesk")])))
        self.assertEqual((leave.get_method(), split(leave)[0]), ("POST", "https://hub.example.com:7891/v1/leave"))
        self.assertEqual(json.loads(leave.data), {"reason": "going home"})
        self.assertEqual(leave.get_header("X-dsh-token"), TOKEN)

    def test_heartbeat_sends_running_and_version(self):
        op = FakeOpener({"ok": True, "abort": []})
        ac.HubClient("hub.example.com", TOKEN, opener=op, workspaces=["w"]).heartbeat("busy", running=["t1", "t2"])
        self.assertEqual(json.loads(op.requests[0][0].data),
                         {"status": "busy", "workspaces": ["w"], "running": ["t1", "t2"], "client_version": ac.CLIENT_VERSION})


# --- run: heartbeat, abort, back-off ------------------------------------------------------------

class FakeClock:
    def __init__(self):
        self.now, self.sleeps = 1000.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class TestRun(TempCase):
    def setUp(self):
        super().setUp()
        self.ws = self.path("repo", make=True)
        self.ex = self.path("exchange")
        self.logs = Logs()

    def bridge(self, hub, max_tasks=2):
        return ac.Bridge(hub, self.ex, max_tasks, log=self.logs, node="mydesk", workspaces={"deepseek-harness": self.ws}, wait=25)

    def test_heartbeat_reports_running_and_applies_abort(self):
        hub = FakeHub()
        br = self.bridge(hub)
        for box, tid in (("inbox", "t-in"), ("working", "t-work"), ("outbox", "t-out"), ("failed", "t-fail")):
            os.makedirs(os.path.join(self.ex, box, tid))
        os.makedirs(os.path.join(self.ex, "inbox", ".t-part.part"))
        br.heartbeat("idle")
        self.assertEqual(hub.running_seen, ["t-fail", "t-in", "t-out", "t-work"])
        hub.abort_ids = ["t-in", "t-work", "../escape", "t-unknown"]
        br.heartbeat("idle")
        self.assertFalse(os.path.exists(os.path.join(self.ex, "inbox", "t-in")))
        self.assertTrue(os.path.isfile(os.path.join(self.ex, "archive", "t-in", ac.ABORT_MARK)))
        self.assertTrue(os.path.isfile(os.path.join(self.ex, "working", "t-work", ac.ABORT_MARK)), "the agent is told to stop")
        self.assertEqual(br.aborted, 2)
        self.assertIn("aborted by the hub", self.logs.joined())
        self.assertFalse(os.path.exists(self.path("escape")))
        hub.abort_ids = []
        br.heartbeat("idle")
        self.assertEqual(hub.running_seen, ["t-fail", "t-out"], "aborted tasks are no longer reported as held")

    def test_start_backs_off_5_to_60_and_401_is_fatal(self):
        clock = FakeClock()

        class Flaky(FakeHub):
            fails = 6

            def heartbeat(self, *a, **kw):
                if self.fails > 0:
                    self.fails -= 1
                    raise OSError("connection refused")
                return FakeHub.heartbeat(self, *a, **kw)
        hub = Flaky()
        runner = ac.Runner(self.bridge(hub), 30, 25, log=self.logs, sleep=clock.sleep, clock=clock)
        runner.start()
        self.assertEqual(clock.sleeps, [5, 10, 20, 40, 60, 60])
        self.assertEqual(runner.heartbeats, 1)

        class Revoked(FakeHub):
            def heartbeat(self, *a, **kw):
                raise ac.HubError(401, "unauthorized", "agent revoked")
        with self.assertRaises(ac.HubError):
            ac.Runner(self.bridge(Revoked()), 30, 25, log=self.logs, sleep=clock.sleep, clock=clock).start()

    def test_cycles_heartbeat_on_schedule_and_cut_the_long_poll(self):
        clock = FakeClock()
        hub = FakeHub()
        br = self.bridge(hub)
        polls = []
        orig = br.pull

        def pull():
            polls.append(br.wait)
            clock.now += br.wait  # the long poll waited its full time
            return orig()
        br.pull = pull
        runner = ac.Runner(br, 30, 25, log=self.logs, sleep=clock.sleep, clock=clock)
        runner.run(cycles=4)
        # heartbeat at t=0 (start); polls of 25 s then 5 s (cut to the next heartbeat); heartbeat at t=30; 25 + 5 again
        self.assertEqual(polls, [25, 5, 25, 5])
        self.assertEqual(runner.heartbeats, 2)
        self.assertEqual(len(hub.of("heartbeat")), 2)

    def test_full_exchange_sleeps_instead_of_spinning(self):
        clock = FakeClock()
        hub = FakeHub()
        br = self.bridge(hub, max_tasks=1)
        os.makedirs(os.path.join(self.ex, "working", "t0"))
        runner = ac.Runner(br, 30, 25, log=self.logs, sleep=clock.sleep, clock=clock)
        runner.run(cycles=2)
        self.assertEqual(hub.of("poll"), [])
        self.assertTrue(clock.sleeps and all(1 <= s <= 5 for s in clock.sleeps))

    def test_network_errors_in_the_loop_back_off_and_recover(self):
        clock = FakeClock()

        class Blip(FakeHub):
            n = 0

            def poll(self, *a, **kw):
                self.n += 1
                if self.n == 1:
                    raise OSError("reset")
                return FakeHub.poll(self, *a, **kw)
        runner = ac.Runner(self.bridge(Blip()), 30, 0, log=self.logs, sleep=clock.sleep, clock=clock)
        runner.run(cycles=2)
        self.assertIn(5, clock.sleeps)
        self.assertIn("retrying in 5 s", self.logs.joined())
        self.assertEqual(runner.backoff, 5, "reset after a good cycle")

    def test_403_ip_not_allowed_backs_off_and_recovers_while_403_forbidden_is_fatal(self):
        clock = FakeClock()

        class IpDrift(FakeHub):
            fails = 3

            def heartbeat(self, *a, **kw):
                if self.fails > 0:
                    self.fails -= 1
                    raise ac.HubError(403, "ip-not-allowed", "client address is not allowed")
                return FakeHub.heartbeat(self, *a, **kw)
        hub = IpDrift()
        runner = ac.Runner(self.bridge(hub), 30, 25, log=self.logs, sleep=clock.sleep, clock=clock)
        runner.start()
        self.assertEqual(clock.sleeps, [5, 10, 20])
        self.assertEqual(runner.heartbeats, 1)

        class Forbidden(FakeHub):
            def heartbeat(self, *a, **kw):
                raise ac.HubError(403, "forbidden", "wrong role")
        with self.assertRaises(ac.HubError):
            ac.Runner(self.bridge(Forbidden()), 30, 25, log=self.logs, sleep=clock.sleep, clock=clock).start()

    def test_busy_deduplicates_inbox_and_working(self):
        hub = FakeHub()
        br = self.bridge(hub, max_tasks=2)
        os.makedirs(os.path.join(self.ex, "inbox", "t1"))
        os.makedirs(os.path.join(self.ex, "working", "t1"))
        self.assertEqual(br._busy(), 1)

    def test_claim_task_atomic_rename_and_concurrent_race(self):
        import concurrent.futures
        ac.ensure_exchange(self.ex)
        tid = "task_atomic_01"
        tdir = os.path.join(self.ex, "inbox", tid)
        os.makedirs(tdir)
        with open(os.path.join(tdir, "task.json"), "w", encoding="utf-8") as f:
            json.dump({"task_id": tid, "effort_resolved": {"mode": "fast", "thinking": "off"}}, f)

        def racer(idx):
            return ac.claim_task(self.ex, tid, by=f"routine-{idx}", nonce=f"n-{idx}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(racer, range(16)))
        winners = [r for r in results if r["claimed"]]
        losers = [r for r in results if not r["claimed"]]
        self.assertEqual(len(winners), 1)
        self.assertEqual(len(losers), 15)
        self.assertFalse(os.path.exists(tdir))
        self.assertTrue(os.path.isfile(os.path.join(self.ex, "working", tid, "claim.json")))
        # Cannot re-claim once in working/ or outbox/
        again = ac.claim_task(self.ex, tid, by="late")
        self.assertFalse(again["claimed"])
        os.makedirs(os.path.join(self.ex, "outbox", "task_done"))
        os.makedirs(os.path.join(self.ex, "inbox", "task_done"))
        self.assertFalse(ac.claim_task(self.ex, "task_done", by="late")["claimed"])


# --- check -----------------------------------------------------------------------------------------

class TestCheck(unittest.TestCase):
    URL = "hub.example.com"

    def run_check(self, *responses, probe=None, **kw):
        out = Logs()
        op = FakeOpener(*responses)
        ticks = iter([0.0])  # started = 0 s, every later reading = 42 ms
        kw.setdefault("env_proxies", {})
        code = ac.run_check(self.URL, opener=op, probe=probe or (lambda h, p, t: None), clock=lambda: next(ticks, 0.042), out=out, **kw)
        return code, out.joined(), op

    def test_ok_through_the_proxy(self):
        probed = []
        code, text, op = self.run_check({"ok": True, "version": "2.0.0", "client_ip": "203.0.113.9"},
                                        proxy="http://user:pw-secret@127.0.0.1:7890", probe=lambda h, p, t: probed.append((h, p)))
        self.assertEqual(code, 0)
        self.assertEqual(probed, [("127.0.0.1", 7890)])
        self.assertIn("target:  https://hub.example.com:7891/v1/health", text)
        self.assertIn("proxy:   http://***@127.0.0.1:7890", text)
        self.assertIn("tls:     verified (system CA store", text)
        self.assertIn("time:    42 ms", text)
        self.assertIn("hub:     ok, version 2.0.0", text)
        self.assertIn("seen as: 203.0.113.9", text)
        self.assertIn("result:  OK - hub reachable through http://***@127.0.0.1:7890", text)
        self.assertNotIn("pw-secret", text)
        req = op.requests[0][0]
        self.assertIsNone(req.get_header("X-dsh-token"))
        self.assertEqual(split(req), ("https://hub.example.com:7891/v1/health", []))

    def test_proxy_not_running(self):
        def refuse(h, p, t):
            raise ConnectionRefusedError("refused")
        code, text, op = self.run_check(proxy="http://127.0.0.1:7890", probe=refuse)
        self.assertEqual(code, 1)
        self.assertIn("does not accept connections", text)
        self.assertIn("start Clash / mihomo", text)
        self.assertEqual(op.requests, [], "no request when the proxy is down")

    def test_proxy_refuses_connect(self):
        err = urllib.error.URLError(OSError("Tunnel connection failed: 403 Forbidden"))
        code, text, _ = self.run_check(err, proxy="http://127.0.0.1:7890")
        self.assertEqual(code, 1)
        self.assertIn("refused CONNECT hub.example.com:7891: HTTP 403 Forbidden", text)
        self.assertIn("allow CONNECT to port 7891", text)

    def test_certificate_rejected(self):
        e = ssl.SSLCertVerificationError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate")
        e.verify_message = "self-signed certificate"
        code, text, _ = self.run_check(urllib.error.URLError(e), proxy="http://127.0.0.1:7890")
        self.assertEqual(code, 1)
        self.assertIn("tls:     FAILED", text)
        self.assertIn("rejected (self-signed certificate)", text)
        self.assertIn("--cafile", text)

    def test_hub_unreachable_timeout(self):
        code, text, _ = self.run_check(urllib.error.URLError(socket.timeout("timed out")), proxy="http://127.0.0.1:7890")
        self.assertEqual(code, 1)
        self.assertIn("no answer from hub.example.com:7891 via http://127.0.0.1:7890", text)
        self.assertIn("opens 7891", text)

    def test_ip_not_allowed_names_the_ip_to_add(self):
        code, text, _ = self.run_check(http_error(403, "ip-not-allowed", {"client_ip": "198.51.100.20"}), proxy="http://127.0.0.1:7890")
        self.assertEqual(code, 1)
        self.assertIn("it sees this client as 198.51.100.20", text)
        self.assertIn('add 198.51.100.20 to "allow" in hub.json on the server', text)
        self.assertIn("fixed proxy node in Clash", text)
        self.assertNotIn("DIRECT", text)

    def test_off_to_a_public_hub_notes_the_proxy_fallback(self):
        code, text, op = self.run_check({"ok": True, "version": "2.0.0"}, no_proxy=True)
        self.assertEqual(code, 0)
        self.assertIn("proxy:   none, direct connection", text)
        self.assertIn("note:    DSH_HUB_PROXY=off and hub.example.com is a public address", text)
        self.assertIn("try the proxy (DSH_HUB_PROXY=http://127.0.0.1:7890)", text)
        self.assertFalse(ac.is_public_host("127.0.0.1"))
        self.assertFalse(ac.is_public_host("10.0.0.5"))
        self.assertTrue(ac.is_public_host("8.8.8.8"))
        self.assertTrue(ac.is_public_host("hub.example.com"))

    def test_wrong_service_and_port_7890_note(self):
        self.URL = "hub.example.com:7890"
        code, text, _ = self.run_check(b"<html>Clash</html>", no_proxy=True)
        self.assertEqual(code, 1)
        self.assertIn("port 7890 is the local Clash/mihomo proxy port", text)
        self.assertIn("not a dsh-hub health response", text)

    def test_env_proxy_and_bypass_are_reported(self):
        code, text, _ = self.run_check({"ok": True}, env_proxies={"https": "http://127.0.0.1:7890"}, bypass=lambda h: False)
        self.assertIn("HTTPS_PROXY or the system proxy settings", text)
        code, text, _ = self.run_check({"ok": True}, env_proxies={"https": "http://127.0.0.1:7890"}, bypass=lambda h: True)
        self.assertIn("NO_PROXY", text)
        self.assertIn("direct connection", text)

    def test_main_check_wires_worker_env_and_never_reads_the_token(self):
        tmp = mkdtemp()
        try:
            wd = os.path.join(tmp, "worker")
            # The token "file" is a folder: if check tried to read it, main would exit 2 (local error).
            os.makedirs(os.path.join(wd, "agent.token"))
            with open(os.path.join(wd, ".env"), "w", encoding="utf-8") as f:
                f.write("DSH_HUB_URL=hub.example.com\nDSH_HUB_PROXY=http://127.0.0.1:1\nDSH_AGENT_TOKEN_FILE=agent.token\n")
            out = io.StringIO()
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                code = ac.main(["check", "--worker-dir", wd], env={})
            text = out.getvalue()
            self.assertEqual(code, 1, text)  # nothing listens on port 1: "proxy not running", before any request
            self.assertIn("target:  https://hub.example.com:7891/v1/health", text)
            self.assertIn("proxy:   http://127.0.0.1:1  [DSH_HUB_PROXY (worker/.env)]", text)
            self.assertIn("does not accept connections", text)
            self.assertNotIn("dsha_", text)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
