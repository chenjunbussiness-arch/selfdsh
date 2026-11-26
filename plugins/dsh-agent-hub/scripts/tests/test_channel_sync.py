"""The worker side of the cloud channel: progress.jsonl / session.jsonl go to the hub
(offline lines go out once it is back), and every launcher finds the agent's own files.

    python -m unittest discover -s plugins/dsh-agent-hub/scripts/tests -v
"""
import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import agent_client as ac  # noqa: E402
import worker_executor as we  # noqa: E402
import worker_run  # noqa: E402


def mkdtemp():
    base = os.environ.get("DSH_TEST_TMP") or tempfile.gettempdir()
    path = os.path.join(base, "dsh-sync-" + uuid.uuid4().hex[:12])
    os.makedirs(path)
    return path


class Hub:
    """Records progress / session / result calls; `down` makes every call fail like a dropped network."""

    agent_id = "code-desk"

    def __init__(self):
        self.calls, self.down, self.gone = [], False, set()

    def _check(self, task_id):
        if self.down:
            raise OSError("network is unreachable")
        if task_id in self.gone:
            raise ac.HubError(409, "task-not-active", "x")

    def heartbeat(self, status="idle", workspaces=None, running=None):
        if self.down:
            raise OSError("network is unreachable")
        return {"ok": True}

    def poll(self, max_tasks=1, wait=25):
        return []

    def progress(self, task_id, progress=None, message=None, stage=None, renew=False, attempt=None):
        self._check(task_id)
        self.calls.append(("renew", task_id) if renew and stage is None and message is None and progress is None
                          else ("progress", task_id, stage, message, progress))
        return {"ok": True}

    def session(self, task_id, entries):
        self._check(task_id)
        self.calls.append(("session", task_id, [(e["role"], e["text"]) for e in entries]))
        return {"ok": True}

    def result(self, task_id, status, summary="", files=(), error=None, needs_input=None, attempt=None):
        self._check(task_id)
        self.calls.append(("result", task_id, status, [f["name"] for f in files]))
        return {"ok": True}

    def of(self, kind):
        return [c for c in self.calls if c[0] == kind]


def append(path, *items, newline=True):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8", newline="\n") as f:
        for i, it in enumerate(items):
            f.write((it if isinstance(it, str) else json.dumps(it)) + ("\n" if newline or i < len(items) - 1 else ""))


class TestSync(unittest.TestCase):
    def setUp(self):
        self.root = mkdtemp()
        self.hub = Hub()
        self.br = ac.Bridge(self.hub, self.root, 2, log=lambda m: None, node="desk", wait=0)
        self.work = os.path.join(self.root, "working", "t1")
        os.makedirs(self.work)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_nothing_new_only_renews_the_lease(self):
        self.br.renew()
        self.assertEqual(self.hub.calls, [("renew", "t1")])

    def test_progress_lines_go_out_once_with_their_stage_and_step_runs_collapse(self):
        append(os.path.join(self.work, ac.PROGRESS_FILE),
               {"stage": "started", "message": "go"},
               {"stage": "step", "message": "a"}, {"stage": "step", "message": "b", "progress": 0.5},
               {"stage": "blocked", "message": "need a key"}, "not json", {"stage": "odd", "message": "c"})
        self.br.renew()
        self.assertEqual(self.hub.of("progress"), [("progress", "t1", "started", "go", None),
                                                   ("progress", "t1", "step", "b", 0.5),
                                                   ("progress", "t1", "blocked", "need a key", None),
                                                   ("progress", "t1", "step", "c", None)])
        self.hub.calls.clear()
        self.br.renew()
        self.assertEqual(self.hub.calls, [("renew", "t1")], "nothing is sent twice")

    def test_an_unfinished_last_line_waits_for_its_newline(self):
        p = os.path.join(self.work, ac.SESSION_FILE)
        append(p, {"role": "user", "text": "hi"}, {"role": "assistant", "text": "hal"}, newline=False)
        self.br.renew()
        self.assertEqual(self.hub.of("session"), [("session", "t1", [("user", "hi")])])
        with open(p, "rb+") as f:  # the writer finishes the line: "hal" -> "half" + newline
            data = f.read().replace(b'"hal"}', b'"half"}\n')
            f.seek(0)
            f.write(data)
        self.br.renew()
        self.assertEqual(self.hub.of("session")[-1], ("session", "t1", [("assistant", "half")]))

    def test_session_roles_are_cleaned_and_batched(self):
        append(os.path.join(self.work, ac.SESSION_FILE), *({"role": "user" if i == 0 else "bot", "text": f"m{i}"} for i in range(ac.SESSION_BATCH + 5)))
        self.br.renew()
        batches = self.hub.of("session")
        self.assertEqual([len(b[2]) for b in batches], [ac.SESSION_BATCH, 5])
        self.assertEqual(batches[0][2][0], ("user", "m0"))
        self.assertEqual(batches[0][2][1], ("note", "m1"), "an unknown role becomes a note")

    def test_offline_lines_go_out_after_reconnect(self):
        append(os.path.join(self.work, ac.PROGRESS_FILE), {"stage": "started", "message": "go"})
        self.hub.down = True
        with self.assertRaises(OSError):
            self.br.renew()
        append(os.path.join(self.work, ac.SESSION_FILE), {"role": "assistant", "text": "worked offline"})
        append(os.path.join(self.work, ac.PROGRESS_FILE), {"stage": "step", "message": "still going"})
        # the agent finishes while the hub is out of reach
        out = os.path.join(self.root, "outbox", "t1")
        os.makedirs(out)
        for name in (ac.PROGRESS_FILE, ac.SESSION_FILE):
            shutil.copyfile(os.path.join(self.work, name), os.path.join(out, name))
        append(os.path.join(out, ac.SESSION_FILE), {"role": "assistant", "text": "done"})
        with open(os.path.join(out, "summary.md"), "w", encoding="utf-8") as f:
            f.write("ok")
        with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as f:
            json.dump({"status": "completed"}, f)
        with self.assertRaises(OSError):
            self.br.push()
        self.assertTrue(os.path.isdir(out), "the result waits in outbox/")
        self.hub.down = False
        self.assertEqual(self.br.push(), 1)
        kinds = [c[0] for c in self.hub.calls]
        self.assertEqual(kinds, ["progress", "progress", "session", "result"])
        self.assertEqual([c[2:4] for c in self.hub.of("progress")], [("started", "go"), ("step", "still going")])
        self.assertEqual(self.hub.of("session")[0][2], [("assistant", "worked offline"), ("assistant", "done")])
        self.assertEqual(self.hub.of("result")[0][3], ["summary.md"], "progress / session files are not result files")
        self.assertFalse(os.path.exists(os.path.join(self.root, ac.SYNC_DIR, "t1.json")))

    def test_progress_sent_before_a_drop_is_not_sent_again(self):
        append(os.path.join(self.work, ac.PROGRESS_FILE), {"stage": "started", "message": "go"})
        append(os.path.join(self.work, ac.SESSION_FILE), {"role": "user", "text": "x"})
        def session(task_id, entries):
            raise OSError("dropped")
        self.hub.session = session
        with self.assertRaises(OSError):
            self.br.renew()
        sent = self.hub.of("progress")
        del self.hub.session
        self.br.renew()
        self.assertEqual(self.hub.of("progress"), sent, "progress went out once")
        self.assertEqual(len(self.hub.of("session")), 1)

    def test_a_task_the_hub_no_longer_has_stops_syncing(self):
        self.hub.gone.add("t1")
        append(os.path.join(self.work, ac.PROGRESS_FILE), {"stage": "started"})
        self.br.renew()
        append(os.path.join(self.work, ac.PROGRESS_FILE), {"stage": "step", "message": "more"})
        self.hub.gone.clear()
        self.br.renew()
        self.assertEqual(self.hub.of("progress"), [], "not retried forever")

    def test_aborted_tasks_are_left_alone(self):
        with open(os.path.join(self.work, ac.ABORT_MARK), "w") as f:
            f.write("{}")
        self.br.renew()
        self.assertEqual(self.hub.calls, [])


class TestExecutorTrail(unittest.TestCase):
    def setUp(self):
        self.root = mkdtemp()
        self.ws = os.path.join(self.root, "ws")
        os.makedirs(self.ws)
        with open(os.path.join(self.ws, "a.txt"), "w", encoding="utf-8") as f:
            f.write("one\ntwo\n")
        self.ex = we.Executor(os.path.join(self.root, "exchange"), lambda m: None)
        self.ex.ensure_boxes()

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def run_task(self, tid, context):
        d = os.path.join(self.ex.root, "inbox", tid)
        os.makedirs(d)
        with open(os.path.join(d, "task.json"), "w", encoding="utf-8") as f:
            json.dump({"task_id": tid, "title": "t", "instruction": "read a.txt", "workspace_path": self.ws,
                       "context": context}, f)
        self.assertTrue(self.ex.claim(tid))
        self.ex.handle(tid)

    def lines(self, path):
        with open(path, encoding="utf-8") as f:
            return [json.loads(x) for x in f.read().splitlines()]

    def test_stages_and_session_land_in_the_result_folder(self):
        self.run_task("t1", {"executor": {"action": "file", "path": "a.txt"}})
        out = os.path.join(self.ex.root, "outbox", "t1")
        self.assertEqual([p["stage"] for p in self.lines(os.path.join(out, "progress.jsonl"))], ["started", "step", "uploading"])
        roles = [e["role"] for e in self.lines(os.path.join(out, "session.jsonl"))]
        self.assertEqual(roles, ["user", "note", "tool", "assistant"])
        self.assertTrue(os.path.isfile(os.path.join(out, "result.json")))

    def test_a_refused_task_still_says_why_in_its_session(self):
        self.run_task("t2", {"executor": {"action": "nope"}})
        out = os.path.join(self.ex.root, "failed", "t2")
        last = self.lines(os.path.join(out, "session.jsonl"))[-1]
        self.assertEqual(last["role"], "assistant")
        self.assertTrue(last["error"])


class TestLaunchersFindTheAgentsFiles(unittest.TestCase):
    def setUp(self):
        self.home = mkdtemp()
        self.wd = os.path.join(self.home, "worker")
        self.env = {"DSH_HOME": self.home}
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(ac.main(["init", "--agent", "code-desk", "--dsh-profile", "web"], env=self.env), 0)
            self.assertEqual(ac.main(["init", "--agent", "ops-desk", "--dsh-profile", "ops"], env=self.env), 0)

    def tearDown(self):
        shutil.rmtree(self.home, ignore_errors=True)

    def test_paths_command_prints_the_selected_agents_files(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(ac.main(["paths", "--agent", "ops-desk"], env=self.env), 0)
        files = json.loads(buf.getvalue())
        self.assertEqual(files["agent"], "ops-desk")
        self.assertEqual(files["dsh_profile"], "ops")
        self.assertEqual(files["exchange"], os.path.join(self.wd, "exchange", "ops-desk"))
        self.assertEqual(files["log_file"], os.path.join(self.wd, "logs", "ops-desk.log"))
        self.assertEqual(files["executor_log"], os.path.join(self.wd, "logs", "ops-desk.executor.log"))
        self.assertEqual(files["executor_lock"], os.path.join(self.wd, "exchange", "ops-desk", ".executor.lock"))

    def test_two_agents_and_none_named_is_an_error(self):
        with self.assertRaises(ac.ConfigError):
            ac.resolve_files(None, None, self.env)
        self.assertEqual(ac.resolve_files(None, None, dict(self.env, DSH_AGENT="code-desk"))["agent"], "code-desk")

    def test_worker_run_logs_to_the_agents_log_and_passes_the_agent_on(self):
        args = worker_run.parse_args(["--agent", "code-desk"])
        self.assertEqual(worker_run.client_argv(args), ["run", "--agent", "code-desk"])
        self.assertEqual(worker_run.log_path(args, self.env), os.path.join(self.wd, "logs", "code-desk.log"))
        bad = worker_run.parse_args([])  # two agents, none named: the client says why in run.log
        self.assertEqual(worker_run.log_path(bad, self.env), os.path.join(self.wd, "run.log"))

    def test_executor_reads_the_inbox_the_client_writes(self):
        old = os.environ.get("DSH_HOME")
        os.environ["DSH_HOME"] = self.home
        try:
            args = type("A", (), {"root": None, "agent": "ops-desk"})()
            files = we.resolve_root(args, self.wd)
        finally:
            if old is None:
                os.environ.pop("DSH_HOME")
            else:
                os.environ["DSH_HOME"] = old
        self.assertEqual(files["exchange"], ac.resolve_files(None, "ops-desk", self.env)["exchange"])
        self.assertEqual(files["executor_log"], os.path.join(self.wd, "logs", "ops-desk.executor.log"))


if __name__ == "__main__":
    unittest.main()
