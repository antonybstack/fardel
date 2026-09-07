#!/usr/bin/env python3
"""Serve Unity WebGL builds with Content-Encoding for .gz / .br assets."""
from __future__ import annotations

import mimetypes
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "client" / "Builds" / "WebGL"
PORT = int(os.environ.get("FARDEL_WEBGL_PORT", "8788"))

# extension -> (content-type, content-encoding or None)
SPECIAL = {
    ".js.gz": ("application/javascript", "gzip"),
    ".wasm.gz": ("application/wasm", "gzip"),
    ".data.gz": ("application/octet-stream", "gzip"),
    ".symbols.json.gz": ("application/json", "gzip"),
    ".wasm.unityweb": ("application/wasm", None),
    ".data.unityweb": ("application/octet-stream", None),
    ".js.unityweb": ("application/javascript", None),
    ".unityweb": ("application/octet-stream", None),
    ".js.br": ("application/javascript", "br"),
    ".wasm.br": ("application/wasm", "br"),
    ".data.br": ("application/octet-stream", "br"),
}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # COOP/COEP help some Unity/thread setups; harmless for basic WebGL
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def guess_type(self, path):
        name = Path(path).name
        for ext, (ctype, _enc) in SPECIAL.items():
            if name.endswith(ext[1:]) or path.endswith(ext):
                return ctype
        # double-suffix check
        p = str(path)
        for ext, (ctype, _enc) in SPECIAL.items():
            if p.endswith(ext):
                return ctype
        return super().guess_type(path)

    def send_head(self):
        path = self.translate_path(self.path)
        enc = None
        for ext, (ctype, e) in SPECIAL.items():
            if path.endswith(ext):
                enc = e
                break
        # Monkey-patch via wrapping: call parent then we can't easily add encoding.
        # Re-implement minimal send_head for encoded files.
        if enc is None:
            return super().send_head()

        f = None
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None
        try:
            fs = os.fstat(f.fileno())
            ctype = "application/octet-stream"
            for ext, (c, e) in SPECIAL.items():
                if path.endswith(ext):
                    ctype = c
                    enc = e
                    break
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            # Pages-compatible: omit Content-Encoding; Unity decompressionFallback ungzip's.
            # Set FARDEL_SEND_CONTENT_ENCODING=1 to restore browser-native ungzip.
            if enc and __import__("os").environ.get("FARDEL_SEND_CONTENT_ENCODING") == "1":
                self.send_header("Content-Encoding", enc)
            self.send_header("Content-Length", str(fs.st_size))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            return f
        except Exception:
            f.close()
            raise


def main():
    if not ROOT.is_dir():
        raise SystemExit(f"missing WebGL build at {ROOT}")
    httpd = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Serving {ROOT} on http://127.0.0.1:{PORT}/", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
