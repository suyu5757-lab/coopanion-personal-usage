#!/usr/bin/env python3
"""OpenAI-compatible /v1/audio/speech bridge for a local GPT-SoVITS api_v2 server."""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(ROOT, "adapter-config.json")

# The system proxy must not carry loopback calls to GPT-SoVITS.
os.environ["no_proxy"] = "127.0.0.1,localhost,::1"
os.environ["NO_PROXY"] = os.environ["no_proxy"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def load_config():
    with open(CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def gpt_sovits_speech(text, speed):
    cfg = load_config()
    payload = {
        "text": text,
        "text_lang": cfg.get("text_lang", "zh"),
        "ref_audio_path": cfg["ref_audio_path"],
        "prompt_text": cfg["prompt_text"],
        "prompt_lang": cfg.get("prompt_lang", "zh"),
        "text_split_method": cfg.get("text_split_method", "cut5"),
        "batch_size": 1,
        "media_type": "wav",
        "streaming_mode": False,
        "speed_factor": float(speed if speed is not None else cfg.get("speed_factor", 1.0)),
        "temperature": float(cfg.get("temperature", 1.0)),
    }
    req = urllib.request.Request(
        cfg.get("gpt_sovits_url", "http://127.0.0.1:9880").rstrip("/") + "/tts",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with OPENER.open(req, timeout=600) as res:
        return res.read()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            try:
                cfg = load_config()
                url = cfg.get("gpt_sovits_url", "http://127.0.0.1:9880").rstrip("/") + "/docs"
                with OPENER.open(url, timeout=2) as res:
                    ok = res.status == 200
                self._json(200 if ok else 503, {"ok": ok})
            except Exception as exc:
                self._json(503, {"ok": False, "error": str(exc)})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/audio/speech":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = str(body.get("input") or "").strip()
            if not text:
                self._json(400, {"error": "input is empty"})
                return
            speed = body.get("speed")
            audio = gpt_sovits_speech(text, speed)
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            self._json(502, {"error": "gpt-sovits HTTP %s" % exc.code, "detail": detail})
        except Exception as exc:
            self._json(502, {"error": str(exc)})


def main():
    cfg = load_config()
    port = int(cfg.get("adapter_port", 9881))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("adapter listening on http://127.0.0.1:%d" % port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
