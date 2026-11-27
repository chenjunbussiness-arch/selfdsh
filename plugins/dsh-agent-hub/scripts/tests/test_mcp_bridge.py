"""Unit tests for scripts/mcp_bridge.py (stdio MCP bridge to dsh-hub). Stdlib only.

    python -m unittest discover -s plugins/dsh-agent-hub/scripts/tests -v

No network: the hub's /oauth/token and /mcp go through a fake opener; the worker side
(heartbeat / lease renew) through a fake HubClient. The patch test needs git.
"""
import io, json, os, shutil, subprocess, sys, tempfile, unittest, urllib.error, uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent_client as ac  # noqa: E402
import mcp_bridge as mb  # noqa: E402


class Res(io.BytesIO):
    def __init__(self, body, status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeHub:
    """A fake opener: /oauth/token hands out numbered bearers, /mcp answers like the real gateway."""

    def __init__(self):
        self.tokens = 0
        self.valid = set()
        self.calls = []
        self.task = {"task_id": "T1", "attempt": 2, "workspace": "demo", "title": "改字段"}
        self.files = None

    def open(self, req, timeout=None):
        url = req.full_url
        body = json.loads(req.data.decode("utf-8")) if req.data else None
        if url.endswith("/oauth/token"):
            assert body["grant_type"] == "client_credentials" and body["client_id"] == "agy-test"
            self.tokens += 1
            tok = f"dshm_{self.tokens}"
            self.valid.add(tok)
            return Res(json.dumps({"access_token": tok, "token_type": "Bearer", "expires_in": 900}).encode())
        assert url.endswith("/mcp"), url
        bearer = req.headers.get("Authorization", "").split(" ")[-1]
        if bearer not in self.valid:
            raise urllib.error.HTTPError(url, 401, "unauthorized", {}, io.BytesIO(b'{"error":{"message":"expired"}}'))
        self.calls.append(body)
        if "id" not in body:
            return Res(b"", 202)
        m = body["method"]
        if m == "initialize":
            result = {"protocolVersion": "2025-06-18", "serverInfo": {"name": "dsh-hub"}, "instructions": "Call next_task."}
        elif m == "tools/call":
            name, args = body["params"]["name"], body["params"]["arguments"]
            if name == "next_task":
                v = {"task": dict(self.task) if self.task else None}
            elif name == "submit_result":
                self.files = args.get("files")
                v = {"ok": True, "summary": args.get("summary")}
            elif name == "report_progress":
                v = {"ok": True, "answers": [{"text": "hub answer"}]}
            else:
                v = {"ok": True}
            result = {"content": [{"type": "text", "text": json.dumps(v)}], "structuredContent": v}
        else:
            result = {}
        return Res(json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}).encode())


class FakeClient:
    url = "https://hub.example:7891/v1"
    agent_id = "agy-test"
    token = "dsha_agy-test_secret"

    def __init__(self, hub):
        self.opener = hub
        self.beats = 0
        self.renews = []
        self.renew_error = None

    def heartbeat(self, status="idle", workspaces=None, running=None):
        assert running is None
        self.beats += 1
        return {"ok": True}

    def progress(self, task_id, renew=False, attempt=None, **kw):
        if self.renew_error:
            raise self.renew_error
        self.renews.append((task_id, attempt, renew))
        return {"ok": True, "answers": [{"text": "kept answer"}]}


def call(name, args=None, mid=1):
    return {"jsonrpc": "2.0", "id": mid, "method": "tools/call", "params": {"name": name, "arguments": args or {}}}


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.base = os.path.join(tempfile.gettempdir(), "dsh-mb-" + uuid.uuid4().hex[:10])
        self.ws = os.path.join(self.base, "demo")
        os.makedirs(self.ws)
        self.hub = FakeHub()
        self.client = FakeClient(self.hub)
        self.now = [1000.0]
        self.mcp = mb.HubMcp(self.client, clock=lambda: self.now[0])
        self.br = mb.Bridge(self.client, self.mcp, {"demo": self.ws}, "coder", io.BytesIO())

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def test_root_and_token_reuse_and_refresh(self):
        self.assertEqual(self.mcp.root, "https://hub.example:7891")
        self.br.handle({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.br.handle({"jsonrpc": "2.0", "id": 2, "method": "ping"})
        self.assertEqual(self.hub.tokens, 1)
        self.now[0] += 900 - 30  # inside the refresh margin
        self.br.handle({"jsonrpc": "2.0", "id": 3, "method": "ping"})
        self.assertEqual(self.hub.tokens, 2)

    def test_401_gets_a_new_bearer_once(self):
        self.br.handle({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        self.hub.valid.clear()  # the hub restarted: bearers are gone
        out = self.br.handle({"jsonrpc": "2.0", "id": 2, "method": "ping"})
        self.assertEqual(out["id"], 2)
        self.assertEqual(self.hub.tokens, 2)

    def test_initialize_adds_role_rules(self):
        out = self.br.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        text = out["result"]["instructions"]
        self.assertTrue(text.startswith("Call next_task."))
        self.assertIn("coder", text)
        self.assertIn("不要跑测试", text)
        self.assertEqual(self.mcp.protocol_version, "2025-06-18")

    def test_notification_gets_no_answer(self):
        self.assertIsNone(self.br.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def test_next_task_heartbeats_adds_local_and_holds(self):
        out = self.br.handle(call("next_task"))
        task = out["result"]["structuredContent"]["task"]
        self.assertEqual(self.client.beats, 1)
        self.assertEqual(task["local"]["workspace_path"], self.ws)
        self.assertEqual(task["local"]["role"], "coder")
        self.assertEqual(json.loads(out["result"]["content"][0]["text"])["task"]["local"]["workspace_path"], self.ws)
        self.assertIn("T1", self.br.held)
        self.br.renew_all()
        self.assertEqual(self.client.renews, [("T1", 2, True)])

    def test_no_task_holds_nothing(self):
        self.hub.task = None
        out = self.br.handle(call("next_task"))
        self.assertIsNone(out["result"]["structuredContent"]["task"])
        self.assertEqual(self.br.held, {})

    def test_unknown_workspace_says_release(self):
        self.hub.task = {"task_id": "T2", "attempt": 1, "workspace": "elsewhere"}
        task = self.br.handle(call("next_task"))["result"]["structuredContent"]["task"]
        self.assertNotIn("workspace_path", task["local"])
        self.assertIn("release_task", task["local"]["note"])

    def test_submit_and_release_stop_the_keepalive(self):
        self.br.handle(call("next_task"))
        self.br.handle(call("release_task", {"task_id": "T1"}))
        self.assertEqual(self.br.held, {})
        self.br.renew_all()
        self.assertEqual(self.client.renews, [])

    def test_lost_task_is_dropped(self):
        self.br.handle(call("next_task"))
        self.client.renew_error = ac.HubError(409, "stale-attempt", "over")
        self.br.renew_all()
        self.assertEqual(self.br.held, {})

    def test_answers_from_keepalive_reach_report_progress(self):
        self.br.handle(call("next_task"))
        self.br.renew_all()
        out = self.br.handle(call("report_progress", {"task_id": "T1", "message": "改到一半"}))
        texts = [a["text"] for a in out["result"]["structuredContent"]["answers"]]
        self.assertEqual(texts, ["kept answer", "hub answer"])
        out = self.br.handle(call("report_progress", {"task_id": "T1"}))
        self.assertEqual([a["text"] for a in out["result"]["structuredContent"]["answers"]], ["hub answer"])

    def test_hub_down_is_a_jsonrpc_error(self):
        def down(req, timeout=None):
            raise OSError("connection refused")
        self.hub.open = down
        out = self.br.handle(call("next_task", mid=7))
        self.assertEqual(out["id"], 7)
        self.assertEqual(out["error"]["code"], -32000)
        self.assertNotIn("dsha_", json.dumps(out))

    def test_serve_reads_lines_and_writes_lines(self):
        out = io.BytesIO()
        self.br.out = out
        self.br.keepalive = 3600
        stdin = io.BytesIO(b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n\nnot json\n{"jsonrpc":"2.0","method":"notifications/x"}\n')
        self.br.serve(stdin)
        lines = [json.loads(x) for x in out.getvalue().decode().splitlines()]
        self.assertEqual([x.get("id") for x in lines], [1, None])
        self.assertEqual(lines[1]["error"]["code"], -32700)


@unittest.skipUnless(shutil.which("git"), "git not installed")
class PatchTests(BridgeTests):
    def git(self, *args):
        subprocess.run(["git", "-C", self.ws, "-c", "user.email=t@t", "-c", "user.name=t", *args], check=True, capture_output=True)

    def setUp(self):
        super().setUp()
        self.git("init", "-q")
        with open(os.path.join(self.ws, "calc.py"), "w") as f:
            f.write("def add(a, b):\n    return a + b\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "init")

    def test_coder_result_gets_changes_patch(self):
        self.br.handle(call("next_task"))
        with open(os.path.join(self.ws, "calc.py"), "a") as f:
            f.write("\n\ndef sub(a, b):\n    return a - b\n")
        with open(os.path.join(self.ws, "new.txt"), "w") as f:
            f.write("new file\n")
        self.br.handle(call("submit_result", {"task_id": "T1", "status": "completed", "summary": "加了 sub"}))
        patch = next(f["text"] for f in self.hub.files if f["name"] == "changes.patch")
        self.assertIn("+def sub(a, b):", patch)
        self.assertIn("new.txt", patch)
        self.assertIn("+new file", patch)
        sub = subprocess.run(["git", "-C", self.ws, "status", "--porcelain"], capture_output=True, text=True).stdout
        self.assertIn("?? new.txt", sub)  # the bridge never touched the index

    def test_agent_patch_and_failed_results_are_left_alone(self):
        self.br.handle(call("next_task"))
        self.br.handle(call("submit_result", {"task_id": "T1", "status": "completed", "summary": "s",
                                              "files": [{"name": "changes.patch", "text": "mine"}]}))
        self.assertEqual(self.hub.files, [{"name": "changes.patch", "text": "mine"}])
        self.hub.files = None
        self.br.handle(call("next_task"))
        self.br.handle(call("submit_result", {"task_id": "T1", "status": "failed", "summary": "s"}))
        self.assertIsNone(self.hub.files)

    def test_no_changes_no_patch(self):
        self.br.handle(call("next_task"))
        self.br.handle(call("submit_result", {"task_id": "T1", "status": "completed", "summary": "看过了"}))
        self.assertIsNone(self.hub.files)
        self.assertIn("没有改动", self.hub.calls[-1]["params"]["arguments"]["summary"])

    def test_dirty_before_is_noted(self):
        with open(os.path.join(self.ws, "calc.py"), "a") as f:
            f.write("# local edit\n")
        task = self.br.handle(call("next_task"))["result"]["structuredContent"]["task"]
        self.assertIn("未提交", task["local"]["note"])


if __name__ == "__main__":
    unittest.main()
