"""Tests for the Codex Mobile bridge.

    python3 -m unittest discover -s mobile/tests -p 'test_*.py'

They run the real bridge over HTTP against fake_app_server.py, so they need
neither Codex nor network access. What they cannot show — that the real
app-server speaks the protocol the bridge expects — is the job of
tests/e2e/run_e2e.mjs.
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE.parent / "bridge"))

import codex_mobile as bridge_module  # noqa: E402

TOKEN = "test-token-" + "x" * 32


class Client:
    def __init__(self, port: int) -> None:
        self.base = f"http://127.0.0.1:{port}"

    def request(self, path, body=None, token=TOKEN, headers=None):
        all_headers = {"Content-Type": "application/json"}
        if token is not None:
            all_headers["Authorization"] = "Bearer " + token
        all_headers.update(headers or {})
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, headers=all_headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as error:
            return error.code, dict(error.headers), error.read()

    def rpc(self, method, params=None):
        status, _, body = self.request("/api/rpc", {"method": method, "params": params or {}})
        return status, json.loads(body)


class EventReader:
    """Reads /api/events in the background, like the phone does."""

    def __init__(self, port: int) -> None:
        self.messages = []
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}/api/events", headers={"Authorization": "Bearer " + TOKEN}
        )
        self._response = urllib.request.urlopen(request, timeout=30)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        try:
            for raw in self._response:
                line = raw.decode().strip()
                if line.startswith("data:"):
                    self.messages.append(json.loads(line[5:]))
        except Exception:  # noqa: BLE001 -- the stream ends when the test does
            pass

    def wait_for(self, predicate, timeout=10):
        deadline = time.time() + timeout
        while time.time() < deadline:
            for message in list(self.messages):
                if predicate(message):
                    return message
            time.sleep(0.05)
        raise AssertionError(f"no matching event; got {[m.get('method') for m in self.messages]}")

    def close(self):
        self._response.close()


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.temp.name) / "workspace"
        self.workspace.mkdir()
        self.log = Path(self.temp.name) / "fake.log"
        env = dict(os.environ, FAKE_APP_SERVER_LOG=str(self.log))
        self.hub = bridge_module.EventHub()
        self.app_server = bridge_module.AppServer(
            [sys.executable, str(HERE / "fake_app_server.py")], self.hub, env=env
        )
        scanner = bridge_module.SecurityScanner(None, self.workspace, self.hub)
        self.bridge = bridge_module.Bridge(
            self.app_server, self.hub, scanner, TOKEN, self.workspace, ["https://proxy.example"]
        )
        self.server = bridge_module.ThreadingHTTPServer(("127.0.0.1", 0), bridge_module.make_handler(self.bridge))
        self.server.daemon_threads = True
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.app_server.start()
        self.assertTrue(self.app_server.wait_ready(10), "fake app-server did not become ready")
        self.port = self.server.server_address[1]
        self.client = Client(self.port)
        self.readers = []

    def tearDown(self):
        for reader in self.readers:
            reader.close()
        self.hub.close_all()
        self.app_server.stop()
        self.server.shutdown()
        self.server.server_close()
        self.temp.cleanup()

    def events(self):
        reader = EventReader(self.port)
        self.readers.append(reader)
        reader.wait_for(lambda m: m.get("method") == "bridge/status")
        return reader

    def received(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]

    # -- pairing and origin ------------------------------------------------

    def test_requests_without_or_with_a_wrong_token_are_refused(self):
        status, _, _ = self.client.request("/api/rpc", {"method": "account/read"}, token=None)
        self.assertEqual(status, 401)
        status, _, _ = self.client.request("/api/rpc", {"method": "account/read"}, token="wrong-" + "y" * 40)
        self.assertEqual(status, 401)
        status, _, _ = self.client.request("/api/events", token=None)
        self.assertEqual(status, 401)
        self.assertNotIn("account/read", [m.get("method") for m in self.received()])

    def test_the_right_token_is_accepted(self):
        status, body = self.client.rpc("account/read")
        self.assertEqual(status, 200)
        self.assertEqual(body["result"]["requiresOpenaiAuth"], False)

    def test_a_foreign_origin_is_refused_even_with_the_token(self):
        status, _, _ = self.client.request(
            "/api/rpc", {"method": "account/read"}, headers={"Origin": "https://evil.example"}
        )
        self.assertEqual(status, 403)

    def test_same_origin_and_listed_origins_are_accepted(self):
        for origin in (f"http://127.0.0.1:{self.port}", "https://proxy.example"):
            status, _, _ = self.client.request("/api/rpc", {"method": "account/read"}, headers={"Origin": origin})
            self.assertEqual(status, 200, origin)

    def test_the_hosted_interface_gets_cors_headers_and_a_preflight(self):
        origin = "https://proxy.example"
        request = urllib.request.Request(
            self.client.base + "/api/rpc",
            method="OPTIONS",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "authorization, content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
            self.assertIn("Authorization", response.headers["Access-Control-Allow-Headers"])
            self.assertEqual(response.headers["Access-Control-Allow-Private-Network"], "true")
        status, headers, _ = self.client.request("/api/rpc", {"method": "account/read"}, headers={"Origin": origin})
        self.assertEqual(status, 200)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        # A refused token must still be readable by the page, or it cannot say why.
        status, headers, _ = self.client.request(
            "/api/rpc", {"method": "account/read"}, token="wrong-" + "z" * 40, headers={"Origin": origin}
        )
        self.assertEqual(status, 401)
        self.assertEqual(headers["Access-Control-Allow-Origin"], origin)

    def test_foreign_origins_get_no_preflight_and_no_cors_headers(self):
        request = urllib.request.Request(
            self.client.base + "/api/rpc",
            method="OPTIONS",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 403)
        self.assertIsNone(caught.exception.headers.get("Access-Control-Allow-Origin"))
        status, headers, _ = self.client.request("/api/rpc", {"method": "account/read"}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_same_origin_requests_need_no_cors_headers(self):
        _, headers, _ = self.client.request(
            "/api/rpc", {"method": "account/read"}, headers={"Origin": f"http://127.0.0.1:{self.port}"}
        )
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_the_health_check_needs_no_token_and_says_nothing_private(self):
        status, _, body = self.client.request("/api/health", token=None)
        self.assertEqual(status, 200)
        self.assertEqual(set(json.loads(body)), {"ok", "version"})

    # -- what the phone may do ---------------------------------------------

    def test_methods_outside_the_allowlist_never_reach_codex(self):
        for method in ("command/exec", "process/spawn", "fs/writeFile", "config/value/write", "initialize"):
            status, body = self.client.rpc(method, {"command": ["id"]})
            self.assertEqual(status, 200)
            self.assertEqual(body["error"]["code"], -32601, method)
        received = [m.get("method") for m in self.received()]
        for method in ("command/exec", "process/spawn", "fs/writeFile", "config/value/write"):
            self.assertNotIn(method, received)
        self.assertEqual(received.count("initialize"), 1)  # only the bridge's own

    def test_the_allowlist_holds_only_what_the_interface_uses(self):
        used = set(re.findall(r'rpc\("([a-zA-Z/]+)"', (REPO / "mobile/web/app.js").read_text()))
        self.assertTrue(used, "no rpc calls found in app.js")
        self.assertLessEqual(used, bridge_module.ALLOWED_METHODS, "the interface calls a method the bridge refuses")
        for dangerous in ("command/exec", "process/spawn", "fs/writeFile", "fs/remove", "config/value/write"):
            self.assertNotIn(dangerous, bridge_module.ALLOWED_METHODS)

    def test_new_threads_start_in_the_workspace(self):
        status, body = self.client.rpc("thread/start", {})
        self.assertEqual(body["result"]["cwd"], str(self.workspace))
        sent = [m for m in self.received() if m.get("method") == "thread/start"]
        self.assertEqual(sent[-1]["params"]["cwd"], str(self.workspace))

    # -- approvals ---------------------------------------------------------

    def test_an_approval_reaches_the_phone_and_the_answer_reaches_codex(self):
        events = self.events()
        self.client.rpc("turn/start", {"threadId": "thread-1", "input": []})
        approval = events.wait_for(lambda m: m.get("method") == "item/commandExecution/requestApproval")
        self.assertEqual(approval["id"], 0)

        status, _, body = self.client.request("/api/respond", {"id": 0, "result": {"decision": "accept"}})
        self.assertEqual(json.loads(body), {"result": {}})
        deadline = time.time() + 5
        while time.time() < deadline:
            answers = [m for m in self.received() if m.get("id") == 0 and "result" in m]
            if answers:
                break
            time.sleep(0.05)
        self.assertEqual(answers[0]["result"], {"decision": "accept"})
        events.wait_for(lambda m: m.get("method") == "bridge/requestAnswered")

        # A second answer to the same request is refused, not forwarded twice.
        _, _, body = self.client.request("/api/respond", {"id": 0, "result": {"decision": "decline"}})
        self.assertIn("error", json.loads(body))
        self.assertEqual(len([m for m in self.received() if m.get("id") == 0 and "result" in m]), 1)

    def test_open_approvals_can_be_polled_when_the_stream_is_held_back(self):
        status, _, _ = self.client.request("/api/pending", token=None)
        self.assertEqual(status, 401)
        self.client.rpc("turn/start", {"threadId": "thread-1", "input": []})
        deadline = time.time() + 5
        pending = []
        while time.time() < deadline and not pending:
            _, _, body = self.client.request("/api/pending")
            pending = json.loads(body)["result"]
            time.sleep(0.05)
        self.assertEqual([m["method"] for m in pending], ["item/commandExecution/requestApproval"])
        self.client.request("/api/respond", {"id": 0, "result": {"decision": "accept"}})
        _, _, body = self.client.request("/api/pending")
        self.assertEqual(json.loads(body)["result"], [])

    def test_the_event_stream_asks_proxies_not_to_buffer(self):
        _, headers, _ = self.client.request("/api/health", token=None)
        self.assertEqual(headers.get("X-Accel-Buffering"), "no")
        self.assertIn("no-transform", headers.get("Cache-Control", ""))

    def test_a_phone_that_connects_later_still_sees_open_approvals(self):
        first = self.events()
        self.client.rpc("turn/start", {"threadId": "thread-1", "input": []})
        first.wait_for(lambda m: m.get("method") == "item/commandExecution/requestApproval")
        late = self.events()
        late.wait_for(lambda m: m.get("method") == "item/commandExecution/requestApproval")

    def test_requests_the_phone_cannot_show_are_declined_not_left_hanging(self):
        events = self.events()
        self.client.rpc("turn/start", {"threadId": "thread-1", "input": []})
        events.wait_for(lambda m: m.get("method") == "bridge/notice")
        deadline = time.time() + 5
        declined = []
        while time.time() < deadline and not declined:
            declined = [m for m in self.received() if m.get("id") == "ask-1" and "error" in m]
            time.sleep(0.05)
        self.assertTrue(declined, "the bridge did not answer item/tool/requestUserInput")
        self.assertFalse(
            any(m.get("method") == "item/tool/requestUserInput" for m in events.messages),
            "an unanswerable request was shown to the phone",
        )

    # -- robustness --------------------------------------------------------

    def test_a_crashed_app_server_is_restarted(self):
        events = self.events()
        self.client.rpc("thread/archive", {"threadId": "thread-1"})  # the fake exits
        events.wait_for(lambda m: m.get("method") == "bridge/status" and m["params"]["codex"] == "stopped")
        events.wait_for(lambda m: m.get("method") == "bridge/status" and m["params"]["codex"] == "ready", timeout=15)
        status, body = self.client.rpc("account/read")
        self.assertIn("result", body)
        self.assertEqual([m.get("method") for m in self.received()].count("initialize"), 2)

    def test_oversized_and_malformed_bodies_are_refused(self):
        request = urllib.request.Request(
            self.client.base + "/api/rpc",
            data=b"not json",
            headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=5)
        self.assertEqual(caught.exception.code, 400)

    # -- static files ------------------------------------------------------

    def test_only_the_interface_files_are_served_with_security_headers(self):
        status, headers, body = self.client.request("/", token=None)
        self.assertEqual(status, 200)
        self.assertIn(b"Codex Mobile", body)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        for path in ("/../bridge/codex_mobile.py", "/bridge/codex_mobile.py", "/%2e%2e/bridge/codex_mobile.py", "/etc/passwd"):
            status, _, _ = self.client.request(path, token=None)
            self.assertEqual(status, 404, path)

    def test_every_file_the_page_references_is_served(self):
        html = (REPO / "mobile/web/index.html").read_text()
        referenced = set(re.findall(r'(?:src|href)="([a-z0-9.-]+\.(?:js|css|svg|png|webmanifest))"', html))
        manifest = json.loads((REPO / "mobile/web/manifest.webmanifest").read_text())
        referenced |= {icon["src"] for icon in manifest["icons"]}
        self.assertIn("icon-180.png", referenced, "iPadOS needs a PNG apple-touch-icon")
        self.assertTrue(referenced)
        for name in referenced:
            self.assertIn("/" + name, bridge_module.STATIC_FILES, name)
            status, _, _ = self.client.request("/" + name, token=None)
            self.assertEqual(status, 200, name)

    def test_the_page_has_no_inline_script_or_style(self):
        # The Content-Security-Policy forbids them; the page must not need them.
        html = (REPO / "mobile/web/index.html").read_text()
        self.assertNotRegex(html, r"<script(?![^>]*\bsrc=)[^>]*>")
        self.assertNotRegex(html, r"\sstyle=")
        self.assertNotRegex(html, r"\son[a-z]+=")


class CodespacesTest(unittest.TestCase):
    def test_the_token_comes_from_the_codespaces_secret(self):
        self.assertEqual(bridge_module.read_token(None, {"CODEX_MOBILE_TOKEN": " " + "t" * 30 + "\n"}), "t" * 30)

    def test_a_short_secret_is_not_used_but_does_not_stop_the_bridge(self):
        # In a codespace an error at start means "no bridge", silently.
        token, source = bridge_module.token_and_source(None, {"CODEX_MOBILE_TOKEN": "short"})
        self.assertEqual(source, "generated")
        self.assertNotEqual(token, "short")
        self.assertGreaterEqual(len(token), 40)

    def test_a_short_token_file_still_stops_the_bridge(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
            handle.write("short")
        with self.assertRaises(SystemExit):
            bridge_module.token_and_source(handle.name, {})
        os.unlink(handle.name)

    def test_without_a_secret_a_strong_token_is_generated(self):
        first = bridge_module.read_token(None, {})
        self.assertGreaterEqual(len(first), 40)
        self.assertNotEqual(first, bridge_module.read_token(None, {}))

    def test_the_forwarded_address_follows_the_documented_variables(self):
        env = {"CODESPACE_NAME": "owner-fuzzy-disco-x1", "GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN": "app.github.dev"}
        self.assertEqual(bridge_module.codespace_url(8765, env), "https://owner-fuzzy-disco-x1-8765.app.github.dev")
        self.assertEqual(bridge_module.codespace_url(8765, {}), "")

    def test_the_devcontainer_runs_the_scripts_that_exist(self):
        text = (REPO / ".devcontainer/devcontainer.json").read_text()
        for script in re.findall(r"bash (mobile/codespaces/[a-z]+\.sh)", text):
            self.assertTrue((REPO / script).is_file(), script)
        self.assertIn("8765", text)
        self.assertIn("CODEX_MOBILE_TOKEN", text)
        start = (REPO / "mobile/codespaces/start.sh").read_text()
        self.assertIn("--port 8765", start)


class PublicForkTest(unittest.TestCase):
    def test_fork_upkeep_keeps_exactly_the_codex_mobile_workflows(self):
        # A workflow missing from KEEP would be switched off on the next run;
        # a name in KEEP without a file would keep nothing.
        text = (REPO / ".github/workflows/fork-upkeep.yml").read_text()
        keep = set(re.findall(r'"([a-z-]+\.yml)"', re.search(r"KEEP = \{([^}]*)\}", text).group(1)))
        ours = {"chinook.yml", "mobile.yml", "mobile-pages.yml", "fork-upkeep.yml"}
        self.assertEqual(keep, ours)
        for name in ours:
            self.assertTrue((REPO / ".github/workflows" / name).is_file(), name)

    def test_the_codespace_does_not_trust_the_published_page(self):
        self.assertIn("--no-hosted-ui", (REPO / "mobile/codespaces/start.sh").read_text())

    def test_security_reports_go_to_this_repository_first(self):
        text = (REPO / "SECURITY.md").read_text()
        self.assertLess(text.index("codex-mobile/security/advisories/new"), text.index("bugcrowd"))


class SecurityScanTest(unittest.TestCase):
    def test_exit_code_2_is_unproven_not_clean(self):
        outcome = bridge_module.classify_bot_run(
            2, None, "dependency-bot: the query failed -- OSV unreachable\nIt therefore does not count as passing."
        )
        self.assertEqual(outcome["status"], "unproven")
        self.assertIn("OSV unreachable", outcome["message"])

    def test_no_report_is_an_error_not_clean(self):
        self.assertEqual(bridge_module.classify_bot_run(0, None, "")["status"], "error")
        self.assertEqual(bridge_module.classify_bot_run(1, None, "Traceback ...")["status"], "error")

    def test_a_crash_after_writing_a_report_is_still_an_error(self):
        report = {"summary": {"total": 0}, "findings": []}
        self.assertEqual(bridge_module.classify_bot_run(-9, report, "")["status"], "error")

    def test_findings_and_clean(self):
        finding = {"rule": "r", "severity": "high"}
        self.assertEqual(
            bridge_module.classify_bot_run(0, {"summary": {"total": 1}, "findings": [finding]}, "")["status"],
            "findings",
        )
        self.assertEqual(bridge_module.classify_bot_run(0, {"summary": {"total": 0}, "findings": []}, "")["status"], "clean")

    def test_long_finding_lists_are_cut_and_say_so(self):
        many = [{"rule": "r", "severity": "low"}] * (bridge_module.MAX_FINDINGS_PER_BOT + 5)
        outcome = bridge_module.classify_bot_run(0, {"summary": {"total": len(many)}, "findings": many}, "")
        self.assertEqual(len(outcome["findings"]), bridge_module.MAX_FINDINGS_PER_BOT)
        self.assertTrue(outcome["truncated"])

    def test_the_scan_refuses_without_chinook(self):
        scanner = bridge_module.SecurityScanner(None, Path("."), bridge_module.EventHub())
        with self.assertRaises(bridge_module.RpcError):
            scanner.start([])
        self.assertFalse(scanner.status()["available"])

    def test_unknown_bots_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            scanner = bridge_module.SecurityScanner(Path(temp), Path(temp), bridge_module.EventHub())
            with self.assertRaises(bridge_module.RpcError):
                scanner.start(["rm-bot"])
            self.assertFalse(scanner.running)

    def test_the_bridge_and_the_workflow_pin_the_same_chinook_commit(self):
        # One pin, two places. If they drift, the phone and CI run different bots.
        workflow = (REPO / ".github/workflows/chinook.yml").read_text()
        pins = set(re.findall(r"Pheonix-Studio-cat/Chinook-security/actions/[a-z-]+@([0-9a-f]+)", workflow))
        self.assertEqual(pins, {bridge_module.CHINOOK_COMMIT})
        self.assertRegex(bridge_module.CHINOOK_COMMIT, r"^[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
