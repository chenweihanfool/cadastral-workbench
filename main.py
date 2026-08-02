#!/usr/bin/env python3
"""
CadastralWorkbench — static file server.

All computation runs client-side via Pyodide (Python-in-browser WASM).
This server only delivers HTML / CSS / JS / Python source files.

Runs two ways:
  - As a plain script (Replit, or `python main.py` locally): binds 0.0.0.0
    so a hosting platform can route external traffic in.
  - As a PyInstaller-frozen executable (double-click .exe, no Python
    install required): binds 127.0.0.1 only and auto-opens the browser,
    since it's meant to be a single-machine local tool in that form.
"""
import os
import sys
import http.server
import socketserver
import threading
import webbrowser

FROZEN = getattr(sys, "frozen", False)

PORT = int(os.environ.get("PORT", 8080))

# Serve the bundled assets regardless of cwd. When frozen by PyInstaller,
# --add-data-bundled files live under sys._MEIPASS (a temp extraction dir),
# not next to the .exe itself.
ROOT = sys._MEIPASS if FROZEN else os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        # Quiet server — Replit shows the URL in its own UI; the frozen exe
        # prints its own startup message instead.
        pass

    def end_headers(self):
        # Allow Pyodide's SharedArrayBuffer (needed in some browsers)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        super().end_headers()


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    host = "127.0.0.1" if FROZEN else "0.0.0.0"
    with ReusableTCPServer((host, PORT), Handler) as httpd:
        url = f"http://127.0.0.1:{PORT}"
        print(f"CadastralWorkbench  →  {url}")
        print("Close this window (or press Ctrl-C) to stop.")
        if FROZEN:
            # Open the browser slightly after serve_forever() starts
            # accepting connections, on a background thread so it doesn't
            # block the server from starting.
            threading.Timer(0.5, lambda: webbrowser.open(url)).start()
        httpd.serve_forever()
