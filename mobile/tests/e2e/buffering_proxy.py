#!/usr/bin/env python3
"""A proxy that holds the event stream back completely — the worst a proxy in
front of the bridge (such as GitHub's port forwarding) could do to it.

Everything else is passed through. The end-to-end test runs a whole turn
through it to show the app still works: it notices the silent stream and
polls instead.

    python3 buffering_proxy.py LISTEN_PORT BRIDGE_PORT
"""

import http.client
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN, BRIDGE = int(sys.argv[1]), int(sys.argv[2])
HOP = {"connection", "keep-alive", "transfer-encoding", "content-length"}


class Proxy(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _forward(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        upstream = http.client.HTTPConnection("127.0.0.1", BRIDGE, timeout=600)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        upstream.request(self.command, self.path, body=body, headers=headers)
        response = upstream.getresponse()
        if self.path.startswith("/api/events") and response.status == 200:
            # Headers go out, the stream never does.
            self.send_response(200)
            self.send_header("Content-Type", response.getheader("Content-Type"))
            self.end_headers()
            self.wfile.flush()
            try:
                while response.read(1024):
                    pass
            except OSError:
                pass
            return
        data = response.read()
        self.send_response(response.status)
        for key, value in response.getheaders():
            if key.lower() not in HOP:
                self.send_header(key, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_OPTIONS = _forward


ThreadingHTTPServer(("127.0.0.1", LISTEN), Proxy).serve_forever()
