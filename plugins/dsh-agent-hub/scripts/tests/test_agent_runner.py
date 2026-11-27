"""Unit tests for scripts/agent_runner.py (headless runner). Stdlib only, no network."""
import json, os, shutil, sys, tempfile, unittest, uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent_client as ac  # noqa: E402
import agent_runner as ar  # noqa: E402


class FakeClient:
    agent_id = "cc-test"
    url = "https://hub.example:7891/v1"

    def __init__(self, peek):
        self._peek = peek
        self.beats = 0
        self.reports = []

    def heartbeat(self, status="idle", workspaces=None, running=None):
        self.beats += 1
        return {"ok": True}

    def peek(self):
        return self._peek

    def report_usage(self, usage, task_ids=None):
        self.reports.append((usage, task_ids))
        return {"ok": True}


class Done:
    def __init__(self, stdout, returncode=0):
        self.stdout, self.returncode = stdout, returncode


class UsageTests(unittest.TestCase):
    def test_claude_code_json(self):
        out = json.dumps({"type": "result", "subtype": "success", "total_cost_usd": 0.0421,
                          "usage": {"input_tokens": 12, "output_tokens": 340, "cache_creation_input_tokens": 5000, "cache_read_input_tokens": 9000}})
        self.assertEqual(ar.usage_of_output(out), {"input_tokens": 12, "output_tokens": 340, "cache_creation_input_tokens": 5000,
                                                   "cache_read_input_tokens": 9000, "cost_usd": 0.0421})

    def test_jsonl_events_are_summed(self):
        out = "\n".join([json.dumps({"type": "thread.started"}),
                         json.dumps({"type": "turn.completed", "usage": {"input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 10}}),
                         "not json",
                         json.dumps({"type": "turn.completed", "usage": {"input_tokens": 50, "output_tokens": 5}})])
        self.assertEqual(ar.usage_of_output(out), {"input_tokens": 150, "cache_read_input_tokens": 40, "output_tokens": 15})

    def test_gemini_stats(self):
        out = json.dumps({"response": "ok", "stats": {"models": {"gemini-2.5-pro": {"tokens": {"prompt": 900, "candidates": 100, "total": 1000}}}}})
        self.assertEqual(ar.usage_of_output(out), {"input_tokens": 900, "output_tokens": 100, "total_tokens": 1000})

    def test_nothing(self):
        self.assertIsNone(ar.usage_of_output("done"))
        self.assertIsNone(ar.usage_of_output(""))


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.base = os.path.join(tempfile.gettempdir(), "dsh-ar-" + uuid.uuid4().hex[:10])
        os.makedirs(os.path.join(self.base, "demo"))
        self.cfg = {"command": ["agent", "-p", "{prompt}", "--log", "{tasklog}"], "every": 120, "timeout": 600, "env": {"X": "1"}, "cwd": "{workspace_path}"}

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def test_no_task_starts_nothing(self):
        calls = []
        r = ar.Runner(FakeClient({"available": 0}), {}, self.cfg, run=lambda *a, **k: calls.append(a))
        self.assertEqual(r.once(), {"ran": False, "why": "no-task"})
        self.assertEqual(calls, [])

    def test_over_quota_starts_nothing(self):
        r = ar.Runner(FakeClient({"available": 2, "over_quota": True}), {}, self.cfg, run=lambda *a, **k: self.fail("started"))
        self.assertEqual(r.once()["why"], "quota")

    def test_a_task_runs_the_command_and_reports_usage(self):
        client = FakeClient({"available": 1, "tasks": [{"task_id": "p1.code", "workspace": "demo"}]})
        seen = {}

        def run(argv, cwd=None, env=None, **kw):
            seen.update(argv=argv, cwd=cwd, env=env)
            with open(env["DSH_BRIDGE_TASKLOG"], "a") as f:  # what the bridge writes when it hands out a task
                f.write("p1.code\n")
            return Done(json.dumps({"type": "result", "usage": {"input_tokens": 10, "output_tokens": 20}, "total_cost_usd": 0.01}))
        r = ar.Runner(client, {"demo": os.path.join(self.base, "demo")}, self.cfg, run=run)
        res = r.once()
        self.assertTrue(res["ran"])
        self.assertEqual(seen["argv"][2], ar.PROMPT)
        self.assertEqual(seen["argv"][4], seen["env"]["DSH_BRIDGE_TASKLOG"])
        self.assertEqual(seen["cwd"], os.path.join(self.base, "demo"))
        self.assertEqual(seen["env"]["DSH_AGENT"], "cc-test")
        self.assertEqual(seen["env"]["X"], "1")
        self.assertEqual(client.reports, [({"input_tokens": 10, "output_tokens": 20, "cost_usd": 0.01}, ["p1.code"])])
        self.assertFalse(os.path.exists(seen["env"]["DSH_BRIDGE_TASKLOG"]), "the task log is removed")

    def test_config_is_checked(self):
        path = os.path.join(self.base, "a.json")
        for bad in [{}, {"runner": {"command": ["x"]}}, {"runner": {"command": ["x", "{prompt}"], "every": 5}}]:
            with open(path, "w") as f:
                json.dump(bad, f)
            with self.assertRaises(ac.ConfigError):
                ar.runner_config(path)
        with open(path, "w") as f:
            json.dump({"runner": {"command": ["claude", "-p", "{prompt}"]}}, f)
        self.assertEqual(ar.runner_config(path)["every"], 120)


class CanTests(unittest.TestCase):
    def test_parse_can(self):
        self.assertEqual(ac.parse_can(["test", "code"]), ["code", "test"])
        self.assertEqual(ac.parse_can("code, test"), ["code", "test"])
        self.assertIsNone(ac.parse_can(None))
        with self.assertRaises(ac.ConfigError):
            ac.parse_can(["fly"])


if __name__ == "__main__":
    unittest.main()
