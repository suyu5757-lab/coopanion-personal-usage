#!/usr/bin/env python3
"""OpenAI-compatible /v1/audio/speech bridge for a local GPT-SoVITS api_v2 server."""

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.environ.get("COOPANION_TTS_CONFIG", os.path.join(ROOT, "adapter-config.json"))

# The system proxy must not carry loopback calls to GPT-SoVITS.
os.environ["no_proxy"] = "127.0.0.1,localhost,::1"
os.environ["NO_PROXY"] = os.environ["no_proxy"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def load_config():
    with open(CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def pick_emotion(cfg, text, emotion):
    refs = cfg.get("emotion_refs") or {}
    if not refs:
        return None
    aliases = cfg.get("emotion_aliases") or {}
    raw = str(emotion or "").strip().strip("【】<>").strip()
    if raw:
        for part in raw.replace("，", ",").replace("、", ",").split(","):
            part = part.strip()
            if not part:
                continue
            key = aliases.get(part) or aliases.get(part.lower())
            if key is None and part.lower() in refs:
                key = part.lower()
            if key in refs:
                return key
    keywords = (cfg.get("emotion_keywords") or {}) if cfg.get("emotion_keyword_fallback", False) else {}
    for key, words in keywords.items():
        if key not in refs:
            continue
        if any(word and word in text for word in words):
            return key
    default = cfg.get("default_emotion", "neutral")
    return default if default in refs else next(iter(refs))


def gpt_sovits_speech(text, speed, emotion):
    cfg = load_config()
    refs = cfg.get("emotion_refs") or {}
    key = pick_emotion(cfg, text, emotion)
    picked = refs.get(key) if key else None
    ref_audio_path = picked.get("ref_audio_path") if picked else cfg["ref_audio_path"]
    prompt_text = picked.get("prompt_text") if picked else cfg["prompt_text"]
    if speed is not None:
        speed_factor = float(speed)
    elif picked:
        speed_factor = float(picked.get("speed_factor", cfg.get("speed_factor", 1.0)))
    else:
        speed_factor = float(cfg.get("speed_factor", 1.0))
    temperature = float(picked.get("temperature", cfg.get("temperature", 1.0))) if picked else float(cfg.get("temperature", 1.0))
    payload = {
        "text": text,
        "text_lang": cfg.get("text_lang", "zh"),
        "ref_audio_path": ref_audio_path,
        "prompt_text": prompt_text,
        "prompt_lang": cfg.get("prompt_lang", "zh"),
        "text_split_method": cfg.get("text_split_method", "cut5"),
        "batch_size": 1,
        "media_type": "wav",
        "streaming_mode": False,
        "speed_factor": speed_factor,
        "temperature": temperature,
    }
    # Auxiliary references and sampling settings are selected with the emotion, not inferred from the words.
    for name in ("aux_ref_audio_paths", "top_k", "top_p", "seed", "parallel_infer", "repetition_penalty"):
        if picked and name in picked:
            payload[name] = picked[name]
        elif name in cfg:
            payload[name] = cfg[name]
    req = urllib.request.Request(
        cfg.get("gpt_sovits_url", "http://127.0.0.1:9880").rstrip("/") + "/tts",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with OPENER.open(req, timeout=600) as res:
        return res.read(), key


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
            emotion = body.get("emotion")
            audio, key = gpt_sovits_speech(text, speed, emotion)
            sys.stderr.write("emotion %s\n" % key)
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
