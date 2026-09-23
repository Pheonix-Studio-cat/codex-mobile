#!/usr/bin/env python3
"""A scripted stand-in for the Responses API, for the end-to-end test.

Turn 1 asks for a shell command (so Codex must ask the phone for approval),
turn 2 answers with streamed text. It never talks to the internet.

    python3 mock_responses.py --port 0 --port-file PATH
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKER_FILE = "codex-mobile-e2e.txt"
FINAL_TEXT = "Done. I created **codex-mobile-e2e.txt** with `touch`.\n\n- step one\n- step two"


def sse(events):
    out = []
    for event in events:
        out.append(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n")
    return "".join(out).encode("utf-8")


def completed(response_id):
    return {
        "type": "response.completed",
        "response": {
            "id": response_id,
            "usage": {
                "input_tokens": 0,
                "input_tokens_details": None,
                "output_tokens": 0,
                "output_tokens_details": None,
                "total_tokens": 0,
            },
        },
    }


def shell_call(tools):
    """Picks whichever shell tool this Codex version offers."""
    names = {tool.get("name") for tool in tools if isinstance(tool, dict)}
    command = f"touch {MARKER_FILE}"
    # Asking to leave the sandbox is what makes Codex ask the user first.
    escalate = {"sandbox_permissions": "require_escalated", "justification": "end-to-end test"}
    if "shell_command" in names:
        return "shell_command", {"command": command, **escalate}
    if "exec_command" in names:
        return "exec_command", {"cmd": command, **escalate}
    if "shell" in names:
        return "shell", {"command": ["bash", "-lc", command], **escalate}
    raise RuntimeError(f"no shell tool offered: {sorted(n for n in names if n)}")


class Handler(BaseHTTPRequestHandler):
    requests_seen = 0
    lock = threading.Lock()

    def log_message(self, format, *args):  # noqa: A002
        print(f"[mock] {format % args}", file=sys.stderr, flush=True)

    def do_GET(self):  # noqa: N802
        # Model catalog lookups: answer with an empty list.
        body = json.dumps({"models": [], "data": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        request = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.rstrip("/").endswith("/responses"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        with Handler.lock:
            Handler.requests_seen += 1
            number = Handler.requests_seen
        items = request.get("input") or []
        has_tool_output = any(
            isinstance(item, dict) and item.get("type") in ("function_call_output", "custom_tool_call_output")
            for item in items
        )
        response_id = f"resp-{number}"
        if not has_tool_output:
            name, arguments = shell_call(request.get("tools") or [])
            events = [
                {"type": "response.created", "response": {"id": response_id}},
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "function_call",
                        "call_id": f"call-{number}",
                        "name": name,
                        "arguments": json.dumps(arguments),
                    },
                },
                completed(response_id),
            ]
        else:
            message_id = f"msg-{number}"
            events = [
                {"type": "response.created", "response": {"id": response_id}},
                {
                    "type": "response.output_item.added",
                    "item": {"type": "message", "role": "assistant", "id": message_id, "content": []},
                },
            ]
            for piece in (FINAL_TEXT[:20], FINAL_TEXT[20:45], FINAL_TEXT[45:]):
                events.append(
                    {
                        "type": "response.output_text.delta",
                        "item_id": message_id,
                        "output_index": 0,
                        "content_index": 0,
                        "delta": piece,
                    }
                )
            events.append(
                {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "message",
                        "role": "assistant",
                        "id": message_id,
                        "content": [{"type": "output_text", "text": FINAL_TEXT}],
                    },
                }
            )
            events.append(completed(response_id))
        body = sse(events)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--port-file", required=True)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    with open(args.port_file, "w", encoding="utf-8") as handle:
        handle.write(str(server.server_address[1]))
    server.serve_forever()


if __name__ == "__main__":
    main()
