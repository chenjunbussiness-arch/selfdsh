"""Unit tests for scripts/worker_executor.py (the exchange-side executor). Stdlib only.

    python -m unittest discover -s plugins/dsh-agent-hub/scripts/tests -v

No network, no hub: each test builds a throw-away exchange folder, writes a task.json
exactly like agent_client.py does, runs one task and checks the result.json the client
would upload. DSH_TEST_TMP overrides the base folder.
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
import uuid

try:
    worker_executor  # noqa: F821 -- an exec-based runner may inject the module
except NameError:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import worker_executor

we = worker_executor


def mkdtemp():
    base = os.environ.get("DSH_TEST_TMP") or tempfile.gettempdir()
    path = os.path.join(base, "dsh-we-" + uuid.uuid4().hex[:12])
    os.makedirs(path)
    return path


class Exchange:
    """A minimal exchange folder + one executor on it."""

    def __init__(self, workspace, **kwargs):
        self.root = mkdtemp()
        self.workspace = workspace
        self.logs = []
        self.ex = we.Executor(self.root, self.logs.append, **kwargs)
        self.ex.ensure_boxes()

    def task(self, task_id, instruction="", title="t", type="custom", context=None, workspace=None, duties=None):
        d = os.path.join(self.root, "inbox", task_id)
        os.makedirs(d, exist_ok=True)
        task = {"protocol": we.PROTOCOL, "task_id": task_id, "type": type, "title": title,
                "instruction": instruction, "workspace": "dsh-warroom",
                "workspace_path": workspace if workspace is not None else self.workspace,
                "inputs": [], "output": {}, "context": context or {}, "attempt": 1,
                "exchange": {"result_dir": f"outbox/{task_id}", "failed_dir": f"failed/{task_id}"}}
        if duties is not None:
            task["duties"] = duties
        with open(os.path.join(d, "task.json"), "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(task, ensure_ascii=False, indent=2))
        return self.ex.claim(task_id) and self.ex.handle(task_id)

    def result(self, task_id, box="outbox"):
        path = os.path.join(self.root, box, task_id, "result.json")
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def read_file(self, task_id, name, box="outbox"):
        with open(os.path.join(self.root, box, task_id, name), encoding="utf-8") as f:
            return f.read()

    def cleanup(self):
        shutil.rmtree(self.root, ignore_errors=True)


class ExecutorTest(unittest.TestCase):
    def setUp(self):
        self.ws = mkdtemp()
        self.x = Exchange(self.ws)

    def tearDown(self):
        self.x.cleanup()
        shutil.rmtree(self.ws, ignore_errors=True)

    # --- file action ------------------------------------------------------
    def test_file_action_reports_real_size_sha256_and_line(self):
        body = "alpha\nbravo\ncharlie\ndelta\n"
        path = os.path.join(self.ws, "data.txt")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(body)
        instruction = ("工作区根是 . 请只读：计算文件 data.txt 的 sha256 和字节大小，"
                       "并取第 3 行的完整原文。")
        self.x.task("t-file", instruction)
        r = self.x.result("t-file")
        self.assertEqual(r["status"], "completed", r)
        self.assertIn(f"sha256: {hashlib.sha256(body.encode()).hexdigest()}", r["summary"])
        self.assertIn(f"size_bytes: {len(body.encode())}", r["summary"])
        self.assertIn("line3: charlie", r["summary"])
        self.assertIn("sha256:", self.x.read_file("t-file", "summary.md"))

    def test_file_beats_workspace_root_when_both_are_named(self):
        path = os.path.join(self.ws, "README.md")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("# title\nsecond line\n")
        self.x.task("t-rank", f"工作区根是 {self.ws}。计算文件 README.md 的 sha256 并取第 2 行的原文。")
        r = self.x.result("t-rank")
        self.assertEqual(r["status"], "completed", r)
        self.assertIn("line2: second line", r["summary"])
        self.assertIn("path: " + os.path.join(self.ws, "README.md"), r["summary"])

    def test_naming_a_folder_is_refused(self):
        self.x.task("t-dir", f"读取 {self.ws} 的内容和 sha256", title="读目录")
        r = self.x.result("t-dir", "failed")
        self.assertEqual(r["error"]["code"], "IS_DIRECTORY")

    def test_file_action_absolute_path_and_missing_file(self):
        path = os.path.join(self.ws, "abs.txt")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("x\n")
        self.x.task("t-abs", f"读 {path}，回报 sha256", title="读文件")
        self.assertEqual(self.x.result("t-abs")["status"], "completed")
        self.x.task("t-missing", f"读 {os.path.join(self.ws, 'nope.txt')} 的 sha256")
        r = self.x.result("t-missing", "failed")
        self.assertEqual(r["error"]["code"], "FILE_NOT_FOUND")

    def test_file_read_outside_roots_is_refused(self):
        self.x.task("t-out", "读取 C:\\Windows\\win.ini 并回报 sha256")
        r = self.x.result("t-out", "failed")
        self.assertEqual(r["error"]["code"], "PATH_OUTSIDE_WORKSPACE")

    def test_credential_file_is_refused(self):
        path = os.path.join(self.ws, "agent.token")
        with open(path, "w", encoding="utf-8") as f:
            f.write("dsh" + "a_fake_fake\n")
        self.x.task("t-secret", f"读出 {path} 的内容和 sha256")
        r = self.x.result("t-secret", "failed")
        self.assertEqual(r["error"]["code"], "SECRET_FILE")

    # --- script action ----------------------------------------------------
    def test_script_from_fence_is_written_and_run(self):
        instruction = ("请写一个 Python 脚本 out/probe.py 并运行，把 stdout 回传：\n"
                       "```python\nprint('sum', 2 + 3)\n```\n")
        self.x.task("t-script", instruction, type="code")
        r = self.x.result("t-script")
        self.assertEqual(r["status"], "completed", r)
        self.assertIn("exit_code: 0", r["summary"])
        self.assertIn("sum 5", r["summary"])
        script = os.path.join(self.ws, "out", "probe.py")
        self.assertTrue(os.path.isfile(script), script)
        with open(script, encoding="utf-8") as f:
            self.assertIn("print('sum', 2 + 3)", f.read())

    def test_script_failing_exit_code_is_failed(self):
        instruction = "写并运行这个脚本：\n```python\nimport sys\nprint('boom')\nsys.exit(3)\n```\n"
        self.x.task("t-script-fail", instruction, type="code")
        r = self.x.result("t-script-fail", "failed")
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["error"]["code"], "EXIT_CODE")
        self.assertIn("boom", r["summary"])

    def test_script_outside_workspace_is_refused(self):
        instruction = ("写并运行脚本：\n```python\nprint(1)\n```\n写到 C:\\Windows\\Temp\\x\\p.py")
        self.x.task("t-script-out", instruction, type="code")
        r = self.x.result("t-script-out", "failed")
        self.assertEqual(r["error"]["code"], "PATH_OUTSIDE_WORKSPACE")

    # --- run action -------------------------------------------------------
    def test_run_marker_command(self):
        self.x.task("t-run", "命令: Get-ChildItem -Name; Write-Output 'exit-ok'", title="跑命令")
        r = self.x.result("t-run")
        self.assertEqual(r["status"], "completed", r)
        self.assertIn("exit_code: 0", r["summary"])
        self.assertIn("exit-ok", r["summary"])

    def test_run_fenced_command(self):
        instruction = "请在 ${PWD} 运行下面这行命令并回报退出码：\n```pwsh\nWrite-Output \"fence-ok\"\n```\n"
        self.x.task("t-run-fence", instruction)
        r = self.x.result("t-run-fence")
        self.assertIn("fence-ok", r["summary"])

    def test_denied_command_is_refused(self):
        self.x.task("t-deny", "命令: Remove-Item -Recurse -Force .\\out")
        r = self.x.result("t-deny", "failed")
        self.assertEqual(r["error"]["code"], "COMMAND_DENIED")

    def test_a_coder_runs_nothing_and_hands_the_task_back(self):
        self.x.task("t-coder", "命令: Write-Output 'hi'", title="跑命令", duties={"role": "coder", "can": ["改代码"], "cannot": ["执行命令或脚本"]})
        r = self.x.result("t-coder", "failed")
        self.assertEqual(r["error"]["code"], "ROLE_OUT_OF_SCOPE")
        self.assertIn("越界", r["needs_input"])
        self.assertIn("改派给 worker", r["needs_input"])

    def test_denied_git_push_is_refused(self):
        self.x.task("t-deny-git", "命令: git push origin main")
        self.assertEqual(self.x.result("t-deny-git", "failed")["error"]["code"], "COMMAND_DENIED")

    def test_command_timeout(self):
        ex = we.Executor(self.x.root, self.x.logs.append, default_timeout=1)
        ex.ensure_boxes()
        d = os.path.join(self.x.root, "inbox", "t-slow")
        os.makedirs(d)
        with open(os.path.join(d, "task.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump({"task_id": "t-slow", "type": "custom", "title": "slow", "instruction": "",
                       "workspace_path": self.ws, "context": {"executor": {
                           "action": "run", "cmd": "Start-Sleep -Seconds 20"}}}, f)
        ex.claim("t-slow")
        ex.handle("t-slow")
        r = self.x.result("t-slow", "failed")
        self.assertEqual(r["error"]["code"], "EXEC_TIMEOUT")

    def test_cwd_outside_workspace_is_refused(self):
        self.x.task("t-cwd", "run it", context={"executor": {"action": "run", "cmd": "Write-Output hi",
                                                             "cwd": "C:\\Windows"}})
        self.assertEqual(self.x.result("t-cwd", "failed")["error"]["code"], "PATH_OUTSIDE_WORKSPACE")

    # --- unsupported / planning -------------------------------------------
    def test_unsupported_instruction_fails_honestly(self):
        self.x.task("t-none", "帮我看看这个项目做得怎么样，给点建议")
        r = self.x.result("t-none", "failed")
        self.assertEqual(r["status"], "failed")
        self.assertEqual(r["error"]["code"], "UNSUPPORTED_TASK")
        self.assertFalse(r["error"]["retryable"])

    def test_unknown_action_in_context(self):
        self.x.task("t-badact", "", context={"executor": {"action": "browse", "url": "https://example.com"}})
        self.assertEqual(self.x.result("t-badact", "failed")["error"]["code"], "UNSUPPORTED_TASK")

    def test_plan_from_instruction_variants(self):
        cases = [
            ("读文件 a/b/c.py 的 sha256 和第 12 行", "file"),
            ("请写一个脚本，内容如下：\n```python\nprint(1)\n```", "script"),
            ("命令: Get-Date", "run"),
        ]
        for text, action in cases:
            spec, note = we.parse_instruction({"instruction": text, "title": "", "type": "code"})
            self.assertIsNotNone(spec, text)
            self.assertEqual(spec["action"], action, f"{text} -> {spec}")
            self.assertTrue(note)

    def test_line_extraction(self):
        self.assertEqual(we.extract_lines("第 352 行的原文"), [352])
        self.assertEqual(we.extract_lines("line 7 and 第 9 行"), [7, 9])
        self.assertEqual(we.extract_lines("第 3-5 行"), [3, 4, 5])
        self.assertEqual(we.extract_lines("没有行号"), [])

    # --- bookkeeping ------------------------------------------------------
    def test_working_folder_is_cleaned_and_marker_written(self):
        self.x.task("t-clean", "命令: Write-Output ok")
        self.assertEqual(self.x.result("t-clean")["status"], "completed")
        self.assertFalse(os.path.exists(os.path.join(self.x.root, "working", "t-clean")))
        self.assertIn("worker_executor/", self.x.result("t-clean")["executor"]["version"])

    def test_stale_working_task_is_failed_not_rerun(self):
        d = os.path.join(self.x.root, "working", "t-stale")
        os.makedirs(d)
        with open(os.path.join(d, "task.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump({"task_id": "t-stale", "workspace_path": self.ws, "context": {}}, f)
        with open(os.path.join(d, we.START_MARK), "w", encoding="utf-8") as f:
            f.write('{"pid": 1}')
        self.assertEqual(self.x.ex.adopt_or_fail_stale(), 1)
        r = self.x.result("t-stale", "failed")
        self.assertEqual(r["error"]["code"], "EXECUTOR_INTERRUPTED")
        self.assertFalse(os.path.exists(d))

    def test_token_shaped_output_is_redacted(self):
        tok = "dsh" + "a_abcdefghijklmnop1234567890"
        self.x.task("t-token", f"命令: Write-Output '{tok}'")
        r = self.x.result("t-token")
        self.assertNotIn(tok, r["summary"])
        self.assertIn("***[redacted]", r["summary"])

    def test_output_truncation(self):
        ex = we.Executor(self.x.root, self.x.logs.append, output_max=200)
        ex.ensure_boxes()
        d = os.path.join(self.x.root, "inbox", "t-big")
        os.makedirs(d)
        with open(os.path.join(d, "task.json"), "w", encoding="utf-8", newline="\n") as f:
            json.dump({"task_id": "t-big", "type": "custom", "title": "big", "instruction": "",
                       "workspace_path": self.ws, "context": {"executor": {
                           "action": "run", "cmd": "1..5000 | ForEach-Object { $_ }"}}}, f)
        ex.claim("t-big")
        ex.handle("t-big")
        text = self.x.read_file("t-big", "stdout.txt")
        self.assertLessEqual(len(text), 400)
        self.assertIn("chars truncated", text)

    def test_child_environment_is_sanitised(self):
        os.environ["DSH_SHOULD_NOT_LEAK"] = "secret-value"
        try:
            # the deny list refuses $env: outright; the ALLOW-LIST environment is the
            # second line of defence, proven here with a script that prints os.environ
            instruction = ("写并运行这个脚本：\n```python\nimport os\n"
                           "print('[' + os.environ.get('DSH_SHOULD_NOT_LEAK', '') + ']')\n```\n")
            self.x.task("t-env", instruction, type="code")
            r = self.x.result("t-env")
            self.assertEqual(r["status"], "completed", r)
            self.assertIn("[]", r["summary"])
            self.assertNotIn("secret-value", r["summary"])
        finally:
            del os.environ["DSH_SHOULD_NOT_LEAK"]

    def test_env_reading_command_is_denied(self):
        self.x.task("t-env-deny", "命令: Write-Output \"[$env:DSH_SHOULD_NOT_LEAK]\"")
        self.assertEqual(self.x.result("t-env-deny", "failed")["error"]["code"], "COMMAND_DENIED")

    def test_invalid_output_file_name_is_skipped(self):
        # a directive cannot inject an output name here; assert the guard directly
        self.assertFalse(we.FILE_NAME_RE.fullmatch("../evil"))
        self.assertFalse(we.FILE_NAME_RE.fullmatch("a/b"))
        self.assertTrue(we.FILE_NAME_RE.fullmatch("summary.md"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
