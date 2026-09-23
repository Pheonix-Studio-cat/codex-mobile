#!/usr/bin/env python3
"""A stand-in for `codex app-server` over stdio, for the bridge tests.

It answers the handful of methods the tests use, records every message it
receives in the file named by FAKE_APP_SERVER_LOG, and — when asked to start
a turn — sends the server requests a real app-server would send.
"""

import json
import os
import sys

LOG = os.environ.get("FAKE_APP_SERVER_LOG")


def send(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def record(message):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(message) + "\n")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    message = json.loads(line)
    record(message)
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}

    if method is None:
        continue  # a response from the bridge; recorded above
    if request_id is None:
        continue  # a notification such as `initialized`

    if method == "initialize":
        send({"id": request_id, "result": {"userAgent": "fake/1.0", "platformOs": "linux"}})
    elif method == "account/read":
        send({"id": request_id, "result": {"account": None, "requiresOpenaiAuth": False}})
    elif method == "thread/start":
        send({"id": request_id, "result": {"thread": {"id": "thread-1", "cwd": params.get("cwd")}, "cwd": params.get("cwd")}})
    elif method == "turn/start":
        send({"id": request_id, "result": {"turn": {"id": "turn-1", "status": "inProgress", "items": []}}})
        send(
            {
                "id": 0,
                "method": "item/commandExecution/requestApproval",
                "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "call-1", "command": "touch x"},
            }
        )
        send({"id": "ask-1", "method": "item/tool/requestUserInput", "params": {"threadId": "thread-1"}})
    elif method == "thread/archive":
        # Simulates a crash: the bridge must notice and restart us.
        sys.exit(3)
    else:
        send({"id": request_id, "error": {"code": -32601, "message": f"fake does not know {method}"}})
