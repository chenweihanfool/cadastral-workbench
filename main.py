#!/usr/bin/env python3
"""
CadastralWorkbench — static file server for Replit deployment.

All computation runs client-side via Pyodide (Python-in-browser WASM).
This server only delivers HTML / CSS / JS / Python source files.
"""
import os
import http.server
import socketserver

PORT = int(os.environ.get("PORT", 8080))

# Serve from the repo root regardless of cwd
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        # Quiet server — Replit shows the URL in its own UI
        pass

    def end_headers(self):
        # Allow Pyodide's SharedArrayBuffer (needed in some browsers)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with ReusableTCPServer(("", PORT), Handler) as httpd:
        print(f"CadastralWorkbench  →  http://0.0.0.0:{PORT}")
        print("Press Ctrl-C to stop.")
        httpd.serve_forever()
