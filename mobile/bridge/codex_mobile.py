#!/usr/bin/env python3
"""Codex Mobile bridge.

Serves the mobile web interface and relays it to a local `codex app-server`.

Why a bridge at all: `codex app-server --listen ws://...` rejects every request
that carries an `Origin` header, and a browser always sends one. It also only
accepts its token through the `Authorization` header, which a browser cannot
set on a WebSocket. Both are deliberate protections of the app-server, so the
bridge does not work around them — it talks to the app-server over stdio, the
same way the TUI and the SDKs do, and exposes a small, authenticated HTTP API
to the phone instead.

Login is unchanged: the bridge only forwards the app-server's own
`account/*` methods. Credentials stay where Codex keeps them (`$CODEX_HOME`).

Standard library only, Python 3.9+.
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import queue
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlsplit

VERSION = "0.1.0"

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# The web interface is a fixed set of files. Nothing else is served — no
# directory listing, no path resolution from the request.
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/markdown.js": ("markdown.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/icon.svg": ("icon.svg", "image/svg+xml"),
    "/icon-180.png": ("icon-180.png", "image/png"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
}

# The phone may call these app-server methods and nothing else. Everything the
# interface needs is here; what it does not need stays out. In particular
# `command/exec`, `process/spawn`, `fs/*` and `config/*` are not reachable:
# they would run commands or write files without going through the approval
# flow, and a lost phone should not be a shell.
ALLOWED_METHODS = frozenset(
    {
        "account/read",
        "account/login/start",
        "account/login/cancel",
        "account/logout",
        "account/rateLimits/read",
        "model/list",
        "thread/list",
        "thread/start",
        "thread/resume",
        "thread/read",
        "thread/archive",
        "thread/name/set",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
    }
)

# Server requests the phone may answer. Anything else is declined by the
# bridge itself so that the agent is never left waiting for an answer the
# interface cannot give.
ANSWERABLE_SERVER_REQUESTS = frozenset(
    {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
    }
)

# The same interface, published on GitHub Pages. The bridge accepts it as an
# origin by default so the hosted page can be installed on a phone once and
# pointed at any bridge. It still needs the pairing token for every request.
HOSTED_UI_URL = "https://pheonix-studio-cat.github.io/codex-mobile/"
HOSTED_UI_ORIGIN = "https://pheonix-studio-cat.github.io"

MAX_BODY_BYTES = 1_000_000
RPC_TIMEOUT_SECONDS = 60
KEEPALIVE_SECONDS = 15

# Chinook Security, pinned. The same commit is used by
# .github/workflows/chinook.yml; a check keeps both in step.
CHINOOK_REPO = "https://github.com/Pheonix-Studio-cat/Chinook-security.git"
CHINOOK_COMMIT = "fa2e27fbc350375188113f87acb105f3c87723b6"
CHINOOK_BOTS = ("secret-bot", "workflow-bot", "code-bot", "dependency-bot", "license-bot")
CHINOOK_TIMEOUT_SECONDS = 900
MAX_FINDINGS_PER_BOT = 200


def log(message: str) -> None:
    print(f"[codex-mobile] {message}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Event fan-out
# --------------------------------------------------------------------------


class EventHub:
    """Delivers every message to every connected phone."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: List["queue.Queue[Optional[dict]]"] = []

    def subscribe(self) -> "queue.Queue[Optional[dict]]":
        q: "queue.Queue[Optional[dict]]" = queue.Queue(maxsize=5000)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: "queue.Queue[Optional[dict]]") -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def publish(self, message: dict) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            try:
                q.put_nowait(message)
            except queue.Full:
                # A client that stopped reading loses its stream, not the
                # others'. It reconnects and resynchronises.
                self.unsubscribe(q)
                try:
                    q.put_nowait(None)
                except queue.Full:
                    pass

    def close_all(self) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
            self._subscribers.clear()
        for q in subscribers:
            try:
                q.put_nowait(None)
            except queue.Full:
                pass


# --------------------------------------------------------------------------
# The app-server connection
# --------------------------------------------------------------------------


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def as_json(self) -> dict:
        error = {"code": self.code, "message": self.message}
        if self.data is not None:
            error["data"] = self.data
        return error


class AppServer:
    """One `codex app-server` over stdio, restarted if it dies."""

    def __init__(self, command: List[str], hub: EventHub, env: Optional[dict] = None) -> None:
        self._command = command
        self._env = env
        self._hub = hub
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._next_id = 1
        self._waiting: Dict[int, "queue.Queue[dict]"] = {}
        self._pending_server_requests: Dict[str, dict] = {}
        self._process: Optional[subprocess.Popen] = None
        self._stopping = False
        self._ready = threading.Event()
        self.state = "starting"
        self.last_error = ""
        self.server_info: dict = {}

    # -- lifecycle ---------------------------------------------------------

    def start(self) -> None:
        threading.Thread(target=self._supervise, name="app-server", daemon=True).start()

    def stop(self) -> None:
        self._stopping = True
        process = self._process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()

    def wait_ready(self, timeout: float) -> bool:
        return self._ready.wait(timeout)

    def _supervise(self) -> None:
        delay = 1.0
        while not self._stopping:
            started = time.monotonic()
            try:
                self._run_once()
            except FileNotFoundError:
                self._set_state("failed", f"codex not found: {self._command[0]}")
                return
            except Exception as error:  # noqa: BLE001 -- reported, then retried
                self._set_state("failed", f"{type(error).__name__}: {error}")
            if self._stopping:
                return
            # Quick crashes back off; a long healthy run resets the delay.
            delay = 1.0 if time.monotonic() - started > 60 else min(delay * 2, 30.0)
            log(f"app-server stopped ({self.last_error or 'no reason'}); restarting in {delay:.0f}s")
            time.sleep(delay)

    def _set_state(self, state: str, error: str = "") -> None:
        self.state = state
        self.last_error = error
        self._hub.publish({"method": "bridge/status", "params": self.status()})

    def status(self) -> dict:
        return {"codex": self.state, "error": self.last_error, "server": self.server_info}

    def _run_once(self) -> None:
        self._ready.clear()
        self._set_state("starting")
        process = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self._env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._process = process
        threading.Thread(target=self._pump_stderr, args=(process,), daemon=True).start()
        reader = threading.Thread(target=self._pump_stdout, args=(process,), daemon=True)
        reader.start()

        try:
            result = self.request(
                "initialize",
                {
                    "clientInfo": {"name": "codex_mobile", "title": "Codex Mobile", "version": VERSION},
                    "capabilities": {"experimentalApi": False},
                },
                timeout=30,
            )
            self.server_info = {
                "userAgent": result.get("userAgent", ""),
                "platformOs": result.get("platformOs", ""),
            }
            self.notify("initialized", None)
            self._set_state("ready")
            self._ready.set()
        except RpcError as error:
            self._set_state("failed", f"initialize failed: {error.message}")
            process.kill()

        reader.join()
        process.wait()
        self._ready.clear()
        self._fail_waiting(f"codex app-server exited with code {process.returncode}")
        self._set_state("stopped", f"exit code {process.returncode}")

    def _pump_stderr(self, process: subprocess.Popen) -> None:
        assert process.stderr is not None
        for line in process.stderr:
            line = line.rstrip()
            if line:
                log(f"app-server: {line}")

    def _pump_stdout(self, process: subprocess.Popen) -> None:
        assert process.stdout is not None
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                log("app-server wrote a line that is not JSON; ignored")
                continue
            if isinstance(message, dict):
                self._dispatch(message)

    # -- messages ----------------------------------------------------------

    def _dispatch(self, message: dict) -> None:
        has_id = "id" in message
        method = message.get("method")
        if has_id and method is None:
            # A response to one of our requests.
            with self._lock:
                waiter = self._waiting.pop(message["id"], None)
            if waiter is not None:
                waiter.put(message)
            return
        if has_id and method is not None:
            self._on_server_request(message)
            return
        if method == "serverRequest/resolved":
            request_id = (message.get("params") or {}).get("requestId")
            with self._lock:
                self._pending_server_requests.pop(_key(request_id), None)
        self._hub.publish(message)

    def _on_server_request(self, message: dict) -> None:
        if message.get("method") not in ANSWERABLE_SERVER_REQUESTS:
            # Declining is always safe; leaving it unanswered would stall the
            # turn with nobody able to see why.
            self._send(
                {
                    "id": message["id"],
                    "error": {
                        "code": -32601,
                        "message": f"Codex Mobile cannot answer {message.get('method')}",
                    },
                }
            )
            self._hub.publish(
                {
                    "method": "bridge/notice",
                    "params": {"text": f"Declined a request the mobile interface cannot show: {message.get('method')}"},
                }
            )
            return
        with self._lock:
            self._pending_server_requests[_key(message["id"])] = message
        self._hub.publish(message)

    def pending_server_requests(self) -> List[dict]:
        with self._lock:
            return list(self._pending_server_requests.values())

    def answer_server_request(self, request_id: Any, result: Any) -> None:
        with self._lock:
            pending = self._pending_server_requests.pop(_key(request_id), None)
        if pending is None:
            raise RpcError(-32602, "no such pending request (already answered?)")
        self._send({"id": pending["id"], "result": result})
        # Tell every other phone that this one has been answered.
        self._hub.publish({"method": "bridge/requestAnswered", "params": {"requestId": pending["id"]}})

    def request(self, method: str, params: Any, timeout: float = RPC_TIMEOUT_SECONDS) -> Any:
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            waiter: "queue.Queue[dict]" = queue.Queue(maxsize=1)
            self._waiting[request_id] = waiter
        message: dict = {"id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        try:
            self._send(message)
        except RpcError:
            with self._lock:
                self._waiting.pop(request_id, None)
            raise
        try:
            response = waiter.get(timeout=timeout)
        except queue.Empty:
            with self._lock:
                self._waiting.pop(request_id, None)
            raise RpcError(-32000, f"{method}: no answer from codex within {timeout:.0f}s")
        if "error" in response:
            error = response["error"] or {}
            raise RpcError(int(error.get("code", -32000)), str(error.get("message", "error")), error.get("data"))
        return response.get("result")

    def notify(self, method: str, params: Any) -> None:
        message: dict = {"method": method}
        if params is not None:
            message["params"] = params
        self._send(message)

    def _send(self, message: dict) -> None:
        process = self._process
        if process is None or process.poll() is not None or process.stdin is None:
            raise RpcError(-32000, "codex app-server is not running")
        data = json.dumps(message, separators=(",", ":")) + "\n"
        with self._write_lock:
            try:
                process.stdin.write(data)
                process.stdin.flush()
            except (BrokenPipeError, OSError) as error:
                raise RpcError(-32000, f"codex app-server is not reachable: {error}") from error

    def _fail_waiting(self, reason: str) -> None:
        with self._lock:
            waiting = list(self._waiting.values())
            self._waiting.clear()
            self._pending_server_requests.clear()
        for waiter in waiting:
            try:
                waiter.put_nowait({"error": {"code": -32000, "message": reason}})
            except queue.Full:
                pass


def _key(request_id: Any) -> str:
    # JSON-RPC ids may be numbers or strings; the phone sends back what it got.
    return json.dumps(request_id)


# --------------------------------------------------------------------------
# Chinook Security
# --------------------------------------------------------------------------


def default_chinook_dir() -> Path:
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return Path(base) / "codex-mobile" / f"chinook-{CHINOOK_COMMIT[:12]}"


def fetch_chinook(target: Path) -> Path:
    """Clones Chinook Security at the pinned commit. Idempotent."""
    if (target / "chinook" / "cli.py").is_file():
        return target
    git = shutil.which("git")
    if not git:
        raise RuntimeError("git is needed to fetch Chinook Security")
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix="chinook-", dir=str(target.parent)))
    try:
        subprocess.run([git, "init", "-q", str(temp)], check=True)
        subprocess.run([git, "-C", str(temp), "fetch", "-q", "--depth", "1", CHINOOK_REPO, CHINOOK_COMMIT], check=True)
        subprocess.run([git, "-C", str(temp), "checkout", "-q", "FETCH_HEAD"], check=True)
        head = subprocess.run(
            [git, "-C", str(temp), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
        ).stdout.strip()
        if head != CHINOOK_COMMIT:
            raise RuntimeError(f"fetched {head}, expected {CHINOOK_COMMIT}")
        temp.rename(target)
    finally:
        if temp.exists():
            shutil.rmtree(temp, ignore_errors=True)
    return target


def resolve_chinook(explicit: Optional[str]) -> Optional[Path]:
    for candidate in (explicit, os.environ.get("CHINOOK_HOME"), str(default_chinook_dir())):
        if candidate and (Path(candidate) / "chinook" / "cli.py").is_file():
            return Path(candidate).resolve()
    return None


def chinook_commit(path: Path) -> str:
    git = shutil.which("git")
    if not git or not (path / ".git").exists():
        return ""
    result = subprocess.run([git, "-C", str(path), "rev-parse", "HEAD"], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ""


def classify_bot_run(exit_code: int, report: Optional[dict], stderr: str) -> dict:
    """Turns one bot run into what the phone shows.

    The honest part is `unproven`: a run that could not determine anything is
    not a clean run, and the phone must not paint it green.
    """
    if exit_code == 2:
        reason = _first_line(stderr) or "the run could not determine anything"
        return {"status": "unproven", "message": reason, "summary": (report or {}).get("summary"), "findings": []}
    if report is None or exit_code not in (0, 1):
        reason = _first_line(stderr) or f"no report (exit code {exit_code})"
        return {"status": "error", "message": reason, "summary": None, "findings": []}
    findings = report.get("findings") or []
    status = "findings" if findings else "clean"
    return {
        "status": status,
        "message": "",
        "summary": report.get("summary"),
        "findings": findings[:MAX_FINDINGS_PER_BOT],
        "truncated": len(findings) > MAX_FINDINGS_PER_BOT,
    }


def _first_line(text: str) -> str:
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()[:500]
    return ""


class SecurityScanner:
    """Runs the Chinook Security bots over the workspace, one scan at a time."""

    def __init__(self, chinook_dir: Optional[Path], workspace: Path, hub: EventHub, python: str = sys.executable) -> None:
        self.chinook_dir = chinook_dir
        self.workspace = workspace
        self._hub = hub
        self._python = python
        self._lock = threading.Lock()
        self.running = False
        self.last_result: Optional[dict] = None

    def status(self) -> dict:
        commit = chinook_commit(self.chinook_dir) if self.chinook_dir else ""
        return {
            "available": self.chinook_dir is not None,
            "path": str(self.chinook_dir) if self.chinook_dir else "",
            "pinnedCommit": CHINOOK_COMMIT,
            "commit": commit,
            "matchesPin": commit == CHINOOK_COMMIT if commit else None,
            "workspace": str(self.workspace),
            "bots": list(CHINOOK_BOTS),
            "running": self.running,
            "lastResult": self.last_result,
        }

    def start(self, bots: List[str]) -> str:
        if self.chinook_dir is None:
            raise RpcError(-32000, "Chinook Security is not installed; start the bridge with --fetch-chinook")
        unknown = [bot for bot in bots if bot not in CHINOOK_BOTS]
        if unknown:
            raise RpcError(-32602, f"unknown bot(s): {', '.join(unknown)}")
        with self._lock:
            if self.running:
                raise RpcError(-32000, "a scan is already running")
            self.running = True
        scan_id = secrets.token_hex(6)
        threading.Thread(target=self._run, args=(scan_id, bots or list(CHINOOK_BOTS)), daemon=True).start()
        return scan_id

    def _run(self, scan_id: str, bots: List[str]) -> None:
        results = []
        started = time.time()
        try:
            for bot in bots:
                self._hub.publish({"method": "bridge/security/progress", "params": {"scanId": scan_id, "bot": bot}})
                results.append(self._run_bot(bot))
        finally:
            result = {
                "scanId": scan_id,
                "workspace": str(self.workspace),
                "commit": chinook_commit(self.chinook_dir) if self.chinook_dir else "",
                "startedAt": int(started),
                "durationSeconds": round(time.time() - started, 1),
                "bots": results,
            }
            with self._lock:
                self.last_result = result
                self.running = False
            self._hub.publish({"method": "bridge/security/completed", "params": result})

    def _run_bot(self, bot: str) -> dict:
        assert self.chinook_dir is not None
        with tempfile.TemporaryDirectory(prefix="codex-mobile-scan-") as temp:
            report_path = os.path.join(temp, "report.json")
            env = dict(os.environ)
            env["PYTHONPATH"] = str(self.chinook_dir)
            command = [
                self._python,
                "-m",
                "chinook.cli",
                bot,
                "--path",
                str(self.workspace),
                "--json",
                report_path,
                "--fail-on",
                "never",
            ]
            started = time.monotonic()
            try:
                completed = subprocess.run(
                    command,
                    cwd=temp,
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=CHINOOK_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                return {
                    "bot": bot,
                    "exitCode": None,
                    "status": "error",
                    "message": f"timed out after {CHINOOK_TIMEOUT_SECONDS}s",
                    "summary": None,
                    "findings": [],
                }
            report = None
            if os.path.isfile(report_path):
                try:
                    with open(report_path, encoding="utf-8") as handle:
                        report = json.load(handle)
                except (OSError, json.JSONDecodeError):
                    report = None
            outcome = classify_bot_run(completed.returncode, report, completed.stderr or completed.stdout)
            outcome.update(
                {"bot": bot, "exitCode": completed.returncode, "seconds": round(time.monotonic() - started, 1)}
            )
            return outcome


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


class Bridge:
    def __init__(
        self,
        app_server: AppServer,
        hub: EventHub,
        scanner: SecurityScanner,
        token: str,
        workspace: Path,
        allowed_origins: List[str],
    ) -> None:
        self.app_server = app_server
        self.hub = hub
        self.scanner = scanner
        self.token = token
        self.workspace = workspace
        self.allowed_origins = [origin.rstrip("/") for origin in allowed_origins]

    def token_ok(self, header: Optional[str]) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[len("Bearer ") :].encode(), self.token.encode())

    def cross_origin(self, origin: Optional[str], host: Optional[str]) -> Optional[str]:
        """The origin to name in CORS headers, if the request is an allowed
        cross-origin one. Same-origin requests need no CORS headers."""
        if origin is None or origin.rstrip("/") not in self.allowed_origins:
            return None
        if host and urlsplit(origin).netloc == host:
            return None
        return origin.rstrip("/")

    def origin_ok(self, origin: Optional[str], host: Optional[str]) -> bool:
        # Requests without Origin come from non-browser clients; they still
        # need the token. Browser requests must be same-origin or listed.
        if origin is None:
            return True
        origin = origin.rstrip("/")
        if origin in self.allowed_origins:
            return True
        if not host:
            return False
        parts = urlsplit(origin)
        return parts.scheme in ("http", "https") and parts.netloc == host

    def call(self, method: str, params: Any) -> Any:
        if method not in ALLOWED_METHODS:
            raise RpcError(-32601, f"method not available from the mobile interface: {method}")
        if method == "thread/start":
            params = dict(params or {})
            params.setdefault("cwd", str(self.workspace))
        if not self.app_server.wait_ready(timeout=20):
            raise RpcError(-32000, f"codex app-server is not ready ({self.app_server.state})")
        return self.app_server.request(method, params)


SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
}


def make_handler(bridge: Bridge) -> Callable[..., BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = f"CodexMobile/{VERSION}"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        # -- plumbing ------------------------------------------------------

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # The request line never contains the token (it travels in a
            # header or in the URL fragment), so logging it is safe.
            log(f"{self.address_string()} {format % args}")

        def _cors(self) -> None:
            allowed = bridge.cross_origin(self.headers.get("Origin"), self.headers.get("Host"))
            if allowed:
                self.send_header("Access-Control-Allow-Origin", allowed)
                self.send_header("Vary", "Origin")

        def _headers(self, status: int, content_type: str, length: Optional[int]) -> None:
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", content_type)
            if length is not None:
                self.send_header("Content-Length", str(length))
            for name, value in SECURITY_HEADERS.items():
                self.send_header(name, value)
            self.end_headers()

        def _json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload).encode("utf-8")
            self._headers(status, "application/json; charset=utf-8", len(body))
            self.wfile.write(body)

        def _authorized(self) -> bool:
            if not bridge.origin_ok(self.headers.get("Origin"), self.headers.get("Host")):
                self._json(HTTPStatus.FORBIDDEN, {"error": {"code": -32001, "message": "origin not allowed"}})
                return False
            if not bridge.token_ok(self.headers.get("Authorization")):
                self._json(HTTPStatus.UNAUTHORIZED, {"error": {"code": -32001, "message": "pairing token missing or wrong"}})
                return False
            return True

        def _body(self) -> Optional[dict]:
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": {"code": -32600, "message": "body too large"}})
                return None
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._json(HTTPStatus.BAD_REQUEST, {"error": {"code": -32700, "message": "body is not JSON"}})
                return None
            if not isinstance(body, dict):
                self._json(HTTPStatus.BAD_REQUEST, {"error": {"code": -32600, "message": "body must be an object"}})
                return None
            return body

        # -- routes --------------------------------------------------------

        def do_OPTIONS(self) -> None:  # noqa: N802
            """CORS preflight for the hosted interface. Answers only for
            allowed origins; everyone else gets a plain refusal."""
            allowed = bridge.cross_origin(self.headers.get("Origin"), self.headers.get("Host"))
            if not allowed or not urlsplit(self.path).path.startswith("/api/"):
                self.send_response(HTTPStatus.FORBIDDEN)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            # Chrome asks before a public page may talk to a private address.
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            if path in STATIC_FILES:
                name, content_type = STATIC_FILES[path]
                try:
                    body = (WEB_DIR / name).read_bytes()
                except OSError:
                    self._json(HTTPStatus.NOT_FOUND, {"error": {"code": 404, "message": "not found"}})
                    return
                self._headers(HTTPStatus.OK, content_type, len(body))
                self.wfile.write(body)
                return
            if path == "/api/health":
                # Unauthenticated on purpose, and says nothing private.
                self._json(HTTPStatus.OK, {"ok": True, "version": VERSION})
                return
            if not path.startswith("/api/"):
                self._json(HTTPStatus.NOT_FOUND, {"error": {"code": 404, "message": "not found"}})
                return
            if not self._authorized():
                return
            if path == "/api/status":
                self._json(
                    HTTPStatus.OK,
                    {
                        "version": VERSION,
                        "workspace": str(bridge.workspace),
                        "appServer": bridge.app_server.status(),
                        "security": bridge.scanner.status(),
                    },
                )
            elif path == "/api/events":
                self._events()
            elif path == "/api/security":
                self._json(HTTPStatus.OK, bridge.scanner.status())
            else:
                self._json(HTTPStatus.NOT_FOUND, {"error": {"code": 404, "message": "not found"}})

        def do_POST(self) -> None:  # noqa: N802
            path = urlsplit(self.path).path
            if not path.startswith("/api/"):
                self._json(HTTPStatus.NOT_FOUND, {"error": {"code": 404, "message": "not found"}})
                return
            if not self._authorized():
                return
            body = self._body()
            if body is None:
                return
            try:
                if path == "/api/rpc":
                    method = body.get("method")
                    if not isinstance(method, str):
                        raise RpcError(-32600, "method missing")
                    result = bridge.call(method, body.get("params"))
                    self._json(HTTPStatus.OK, {"result": result})
                elif path == "/api/respond":
                    if "id" not in body or "result" not in body:
                        raise RpcError(-32600, "id and result are required")
                    bridge.app_server.answer_server_request(body["id"], body["result"])
                    self._json(HTTPStatus.OK, {"result": {}})
                elif path == "/api/security/scan":
                    bots = body.get("bots") or []
                    if not isinstance(bots, list) or not all(isinstance(bot, str) for bot in bots):
                        raise RpcError(-32602, "bots must be a list of names")
                    scan_id = bridge.scanner.start(bots)
                    self._json(HTTPStatus.OK, {"result": {"scanId": scan_id}})
                else:
                    self._json(HTTPStatus.NOT_FOUND, {"error": {"code": 404, "message": "not found"}})
            except RpcError as error:
                self._json(HTTPStatus.OK, {"error": error.as_json()})

        def _events(self) -> None:
            """Server-sent events, read by the phone with `fetch` so that the
            token can travel in a header (EventSource cannot set one)."""
            subscription = bridge.hub.subscribe()
            try:
                self._headers(HTTPStatus.OK, "text/event-stream; charset=utf-8", None)
                # No Content-Length: the stream ends when the connection does.
                self.close_connection = True
                self._send_event({"method": "bridge/status", "params": bridge.app_server.status()})
                for pending in bridge.app_server.pending_server_requests():
                    self._send_event(pending)
                while True:
                    try:
                        message = subscription.get(timeout=KEEPALIVE_SECONDS)
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
                        continue
                    if message is None:
                        return
                    self._send_event(message)
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            finally:
                bridge.hub.unsubscribe(subscription)

        def _send_event(self, message: dict) -> None:
            data = json.dumps(message, separators=(",", ":"))
            self.wfile.write(f"data: {data}\n\n".encode("utf-8"))
            self.wfile.flush()

    return Handler


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="codex-mobile",
        description="Serve the Codex Mobile interface and relay it to a local `codex app-server`.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="port to listen on (default: 8765)")
    parser.add_argument("--codex", default="codex", help="the codex executable (default: codex on PATH)")
    parser.add_argument(
        "--workspace",
        default=os.getcwd(),
        help="directory new threads start in and the security scan checks (default: current directory)",
    )
    parser.add_argument("--chinook", default=None, help="a Chinook Security checkout (default: $CHINOOK_HOME or the cache)")
    parser.add_argument(
        "--fetch-chinook",
        action="store_true",
        help=f"clone Chinook Security at the pinned commit {CHINOOK_COMMIT[:12]} into the cache first",
    )
    parser.add_argument(
        "--allow-origin",
        action="append",
        default=[],
        help="an extra browser origin to accept, e.g. the HTTPS address of a reverse proxy (repeatable)",
    )
    parser.add_argument(
        "--no-hosted-ui",
        action="store_true",
        help=f"do not accept the interface published at {HOSTED_UI_URL}",
    )
    parser.add_argument(
        "--public-url",
        default="",
        help="the HTTPS address under which the phone reaches this bridge (e.g. a tunnel); used in the pairing link",
    )
    parser.add_argument(
        "--token-file",
        default=None,
        help="read the pairing token from this file instead of generating a new one",
    )
    return parser


def read_token(path: Optional[str]) -> str:
    if path:
        token = Path(path).read_text(encoding="utf-8").strip()
        if len(token) < 24:
            raise SystemExit("the pairing token must be at least 24 characters long")
        return token
    return secrets.token_urlsafe(32)


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    workspace = Path(args.workspace).resolve()
    if not workspace.is_dir():
        raise SystemExit(f"workspace is not a directory: {workspace}")

    if args.fetch_chinook:
        target = Path(args.chinook).resolve() if args.chinook else default_chinook_dir()
        log(f"fetching Chinook Security {CHINOOK_COMMIT[:12]} into {target}")
        fetch_chinook(target)

    token = read_token(args.token_file)
    hub = EventHub()
    app_server = AppServer([args.codex, "app-server"], hub)
    chinook_dir = resolve_chinook(args.chinook)
    scanner = SecurityScanner(chinook_dir, workspace, hub)
    origins = list(args.allow_origin)
    if not args.no_hosted_ui:
        origins.append(HOSTED_UI_ORIGIN)
    bridge = Bridge(app_server, hub, scanner, token, workspace, origins)

    server = ThreadingHTTPServer((args.host, args.port), make_handler(bridge))
    server.daemon_threads = True
    # SIGTERM shuts down like Ctrl-C, so codex app-server is stopped too.
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    app_server.start()

    shown_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    port = server.server_address[1]
    print("", file=sys.stderr)
    print("  Codex Mobile is running.", file=sys.stderr)
    local_url = f"http://{shown_host}:{port}"
    print(f"  Open here:           {local_url}/#token={token}", file=sys.stderr)
    if not args.no_hosted_ui:
        bridge_url = (args.public_url or local_url).rstrip("/")
        print(f"  Or the hosted app:   {HOSTED_UI_URL}#bridge={bridge_url}&token={token}", file=sys.stderr)
        if not args.public_url:
            print("                       (from another device this needs --public-url https://...)", file=sys.stderr)
    print("  The part after # carries the token. It never reaches any server.", file=sys.stderr)
    print(f"  Workspace:           {workspace}", file=sys.stderr)
    print(
        f"  Chinook Security:    {chinook_dir or 'not installed (run with --fetch-chinook)'}",
        file=sys.stderr,
    )
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("", file=sys.stderr)
        print("  WARNING: listening beyond this machine over plain HTTP.", file=sys.stderr)
        print("  Anyone on the network path can read the token. Use a private network", file=sys.stderr)
        print("  (e.g. a VPN) or put an HTTPS reverse proxy in front and pass --allow-origin.", file=sys.stderr)
    print("", file=sys.stderr, flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        hub.close_all()
        app_server.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
