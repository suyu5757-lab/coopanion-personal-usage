#!/usr/bin/env python3
"""OpenAI-compatible /v1/audio/speech bridge for a local GPT-SoVITS api_v2 server."""

import hashlib
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.environ.get("COOPANION_TTS_CONFIG", os.path.join(ROOT, "adapter-config.json"))

# The system proxy must not carry loopback calls to GPT-SoVITS.
os.environ["no_proxy"] = "127.0.0.1,localhost,::1"
os.environ["NO_PROXY"] = os.environ["no_proxy"]
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# One inference at a time: the local model is the scarce resource, and a client
# that gave up still leaves the server computing.
ENGINE = threading.Semaphore(1)

# Marker parts are separated by commas or whitespace, full or half width.
PARTS = re.compile(r"[,，、;；\s]+")
BRACKETS = "【】<>＜＞"


class Busy(Exception):
    """The engine is still working on an earlier request."""


class NoReference(Exception):
    """No configured reference is readable, so this line has to stay text."""


def load_config():
    with open(CONFIG, "r", encoding="utf-8") as f:
        return json.load(f)


def config_fingerprint(cfg):
    """What this voice is configured as, without exposing any path."""
    body = json.dumps(cfg, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(body).hexdigest()[:12]


def wav_ok(path):
    try:
        with open(path, "rb") as f:
            head = f.read(64)
            size = os.fstat(f.fileno()).st_size
    except OSError:
        return False
    if not path.lower().endswith(".wav"):
        return size > 0
    if size < 44 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
        return False
    if head[12:16] != b"fmt " or int.from_bytes(head[16:20], "little") < 16:
        return False
    channels = int.from_bytes(head[22:24], "little")
    rate = int.from_bytes(head[24:28], "little")
    return channels in (1, 2) and 8000 <= rate <= 96000


_health_cache = {}


def reference_health(cfg):
    """参考音是否可读；按路径、大小、修改时间缓存，改文件后自动重查。"""
    refs = cfg.get("emotion_refs") or {}
    health = {}
    for key, item in refs.items():
        path = os.path.expanduser(str((item or {}).get("ref_audio_path") or ""))
        if not path:
            health[key] = False
            continue
        try:
            stat = os.stat(path)
            stamp = (path, stat.st_size, stat.st_mtime_ns)
        except OSError:
            health[key] = False
            continue
        cached = _health_cache.get(stamp)
        if cached is None:
            cached = wav_ok(path)
            _health_cache[stamp] = cached
        health[key] = cached
    return health


def pick_emotion(cfg, text, emotion):
    """按标记选参考音；动作标记、未知标记都不改变上一层的选择。"""
    refs = cfg.get("emotion_refs") or {}
    if not refs:
        return None
    aliases = cfg.get("emotion_aliases") or {}
    raw = str(emotion or "").strip().strip(BRACKETS).strip()
    if raw:
        for part in PARTS.split(raw):
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
    if default in refs:
        return default
    return "neutral" if "neutral" in refs else None


def choose_reference(cfg, text, emotion):
    """(参考音键, 降级原因)；键为 None 表示这次只能出文字。"""
    refs = cfg.get("emotion_refs") or {}
    if not refs:
        return None, None
    health = reference_health(cfg)
    key = pick_emotion(cfg, text, emotion)
    if key and health.get(key):
        return key, None
    if key and key != "neutral" and health.get("neutral"):
        return "neutral", "%s 参考音不可用" % key
    if key is None and health.get("neutral"):
        return "neutral", None
    raise NoReference("没有可用的参考音")


def gpt_sovits_speech(text, speed, emotion):
    cfg = load_config()
    refs = cfg.get("emotion_refs") or {}
    key, fallback = choose_reference(cfg, text, emotion)
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
    # A cancelled client does not stop the model, so the next request waits for a
    # bounded moment and then gets a clear busy answer instead of piling up.
    wait = float(cfg.get("busy_wait_s", 0.25))
    if not ENGINE.acquire(timeout=max(0.0, wait)):
        raise Busy()
    try:
        timeout = float(cfg.get("upstream_timeout_s", 120))
        with OPENER.open(req, timeout=timeout) as res:
            return res.read(), key, fallback
    finally:
        ENGINE.release()


def capabilities(cfg):
    refs = cfg.get("emotion_refs") or {}
    aliases = cfg.get("emotion_aliases") or {}
    health = reference_health(cfg)
    default = cfg.get("default_emotion", "neutral")
    if default not in refs:
        default = "neutral" if "neutral" in refs else None
    return {
        "version": 1,
        "fingerprint": config_fingerprint(cfg),
        "default": default,
        # 只给文件名，不回传私人目录。
        "references": [
            {
                "id": key,
                "healthy": bool(health.get(key)),
                "file": os.path.basename(str((item or {}).get("ref_audio_path") or "")),
            }
            for key, item in refs.items()
        ],
        "aliases": {alias: key for alias, key in aliases.items() if key in refs},
        "missing": [key for key in refs if not health.get(key)],
    }


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
        if self.path == "/capabilities":
            try:
                self._json(200, capabilities(load_config()))
            except Exception as exc:
                self._json(503, {"error": str(exc)})
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
            audio, key, fallback = gpt_sovits_speech(text, speed, emotion)
            fingerprint = config_fingerprint(load_config())
            sys.stderr.write("emotion %s%s\n" % (key, " (fallback: %s)" % fallback if fallback else ""))
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.send_header("X-Coopanion-Reference", key or "default")
            self.send_header("X-Coopanion-Capability", fingerprint)
            if fallback:
                self.send_header("X-Coopanion-Fallback", fallback)
            self.end_headers()
            self.wfile.write(audio)
        except Busy:
            self.send_response(429)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Retry-After", "1")
            body = json.dumps({"error": "busy"}, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except NoReference as exc:
            self.send_response(503)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("X-Coopanion-Fallback", "text-only")
            body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
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
