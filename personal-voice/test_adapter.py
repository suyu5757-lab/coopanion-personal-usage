"""Contract tests for emotion selection, reference health and local inference requests."""

import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


spec = importlib.util.spec_from_file_location("voice_adapter", Path(__file__).with_name("adapter.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


def write_wav(path, ms=20, sample_rate=32000):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, sample_rate, 0, "NONE", "not compressed"))
        wav.writeframes(b"\0\0" * int(sample_rate * ms / 1000))
    return str(path)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        original = adapter.CONFIG
        adapter.CONFIG = str(self.root / "adapter.json")
        self.addCleanup(setattr, adapter, "CONFIG", original)
        previous_unknown = adapter.ENGINE_UNKNOWN
        adapter.ENGINE_UNKNOWN = False
        self.addCleanup(setattr, adapter, "ENGINE_UNKNOWN", previous_unknown)
        neutral = write_wav(self.root / "ref" / "neutral.wav")
        angry = write_wav(self.root / "ref" / "angry.wav")
        self.refs = {"neutral": neutral, "angry": angry}
        self.cfg = {
            "ref_audio_path": neutral,
            "prompt_text": "Default reference.",
            "default_emotion": "neutral",
            "emotion_aliases": {"生气": "angry", "平静": "neutral"},
            "emotion_refs": {
                "neutral": {"ref_audio_path": neutral, "prompt_text": "Neutral reference."},
                "angry": {"ref_audio_path": angry, "prompt_text": "Angry reference."},
            },
            "emotion_keywords": {"angry": ["生气", "!"]},
        }

    def test_body_words_do_not_override_unspecified_or_unrecognized_emotion(self):
        angry = write_wav(self.root / "ref" / "angry2.wav")
        self.cfg["default_emotion"] = "angry"
        self.cfg["emotion_refs"]["angry"]["ref_audio_path"] = angry
        for mood in (None, "", "unrecognized"):
            self.assertEqual(adapter.pick_emotion(self.cfg, "不要生气!", mood), "angry")

    def test_explicit_emotion_wins_over_opted_in_keyword_fallback(self):
        self.cfg["emotion_keyword_fallback"] = True
        self.assertEqual(adapter.pick_emotion(self.cfg, "不要生气!", "neutral"), "neutral")
        self.assertEqual(adapter.pick_emotion(self.cfg, "不要生气!", None), "angry")

    def test_chinese_alias_in_combined_action_marker_selects_reference(self):
        self.assertEqual(adapter.pick_emotion(self.cfg, "Hello.", "【生气，甩尾巴】"), "angry")
        self.assertEqual(adapter.pick_emotion(self.cfg, "Hello.", "生气 甩尾巴"), "angry")
        self.assertEqual(adapter.pick_emotion(self.cfg, "Hello.", "【点头，生气】"), "angry")

    def test_action_only_marker_keeps_the_default_reference(self):
        self.assertEqual(adapter.pick_emotion(self.cfg, "Hello.", "点头"), "neutral")

    def test_never_falls_back_to_an_arbitrary_reference(self):
        self.cfg["emotion_refs"].pop("neutral")
        self.cfg["default_emotion"] = "angry"
        self.assertEqual(adapter.pick_emotion(self.cfg, "Hello.", "点头"), "angry")
        self.cfg["default_emotion"] = "neutral"
        self.assertIsNone(adapter.pick_emotion(self.cfg, "Hello.", "点头"))
        with self.assertRaises(adapter.NoReference):
            adapter.choose_reference(self.cfg, "Hello.", "点头")

    def test_broken_reference_falls_back_to_neutral_with_a_reason(self):
        Path(self.cfg["emotion_refs"]["angry"]["ref_audio_path"]).write_bytes(b"not a wav")
        key, fallback = adapter.choose_reference(self.cfg, "Hello.", "angry")
        self.assertEqual(key, "neutral")
        self.assertIn("angry", fallback)

    def test_unhealthy_neutral_degrades_to_text(self):
        Path(self.cfg["emotion_refs"]["neutral"]["ref_audio_path"]).unlink()
        Path(self.cfg["emotion_refs"]["angry"]["ref_audio_path"]).unlink()
        with self.assertRaises(adapter.NoReference):
            adapter.choose_reference(self.cfg, "Hello.", "angry")

    def test_legacy_single_reference_configuration_still_works(self):
        self.cfg.pop("emotion_refs")
        self.assertIsNone(adapter.pick_emotion(self.cfg, "Hello.", "angry"))
        payload, audio, emotion, fallback = self.roundtrip("angry")
        self.assertEqual(payload["ref_audio_path"], self.cfg["ref_audio_path"])
        self.assertEqual(audio[:4], b"RIFF")
        self.assertIsNone(emotion)
        self.assertIsNone(fallback)
        self.assertNotIn("aux_ref_audio_paths", payload)

    def test_emotion_overrides_auxiliary_reference_and_sampling_without_changing_text(self):
        self.cfg.update(aux_ref_audio_paths=[str(self.root / "ref" / "global.wav")], temperature=1.0, seed=42, top_k=15)
        self.cfg["emotion_refs"]["angry"].update(aux_ref_audio_paths=[], temperature=.7, top_k=10)
        payload, audio, emotion, fallback = self.roundtrip("angry")
        self.assertEqual(payload["ref_audio_path"], self.refs["angry"])
        self.assertEqual(payload["aux_ref_audio_paths"], [])
        self.assertEqual((payload["temperature"], payload["top_k"], payload["seed"]), (.7, 10, 42))
        self.assertEqual(payload["text"], "Hello.")
        self.assertEqual((audio[:4], emotion, fallback), (b"RIFF", "angry", None))

    def test_emotion_inherits_fixed_timbre_reference_and_explicit_speed(self):
        self.cfg.update(aux_ref_audio_paths=[str(self.root / "ref" / "anchor.wav")], top_p=.9, parallel_infer=False)
        payload, _, _, _ = self.roundtrip("neutral", speed=1.1)
        self.assertEqual(payload["aux_ref_audio_paths"], [str(self.root / "ref" / "anchor.wav")])
        self.assertEqual((payload["top_p"], payload["parallel_infer"], payload["speed_factor"]), (.9, False, 1.1))

    def test_wav_health_needs_audio_data_not_just_a_header(self):
        empty = self.root / "ref" / "empty.wav"
        with wave.open(str(empty), "wb") as wav:
            wav.setparams((1, 2, 32000, 0, "NONE", "not compressed"))
        self.assertFalse(adapter.wav_ok(str(empty)))
        truncated = self.root / "ref" / "truncated.wav"
        truncated.write_bytes(b"RIFF" + b"\0" * 40)
        self.assertFalse(adapter.wav_ok(str(truncated)))
        self.assertTrue(adapter.wav_ok(self.refs["neutral"]))

    def test_fallback_response_through_the_real_handler_stays_utf8_safe(self):
        Path(self.refs["angry"]).write_bytes(b"not a wav")
        audio, server, thread = self.serve_upstream()
        self.cfg["gpt_sovits_url"] = "http://127.0.0.1:%d" % server.server_port
        Path(adapter.CONFIG).write_text(json.dumps(self.cfg))
        handler_server = ThreadingHTTPServer(("127.0.0.1", 0), adapter.Handler)
        handler_thread = threading.Thread(target=handler_server.serve_forever, daemon=True)
        handler_thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", handler_server.server_port, timeout=5)
            connection.request(
                "POST", "/v1/audio/speech",
                body=json.dumps({"input": "Hello.", "emotion": "angry"}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("X-Coopanion-Reference"), "neutral")
            self.assertEqual(response.getheader("X-Coopanion-Fallback"), "reference-unavailable:angry")
            self.assertEqual(body, audio)
            connection.close()
        finally:
            handler_server.shutdown()
            handler_server.server_close()
            handler_thread.join()
            server.shutdown()
            server.server_close()
            thread.join()

    def test_a_client_timeout_marks_the_engine_unknown_and_refuses_more_work(self):
        self.cfg["busy_wait_s"] = 0
        Path(adapter.CONFIG).write_text(json.dumps(self.cfg))
        calls = []

        class Opener:
            def open(self, *_args, **_kwargs):
                calls.append(1)
                raise socket.timeout("timed out")

        original = adapter.OPENER
        adapter.OPENER = Opener()
        self.addCleanup(setattr, adapter, "OPENER", original)
        with self.assertRaises(adapter.BusyUnknown):
            adapter.gpt_sovits_speech("Hello.", None, "neutral")
        with self.assertRaises(adapter.BusyUnknown):
            adapter.gpt_sovits_speech("Hello.", None, "neutral")
        self.assertEqual(len(calls), 1)

    def test_capabilities_describe_the_voice_without_paths(self):
        report = adapter.capabilities(self.cfg)
        self.assertEqual(report["default"], "neutral")
        self.assertEqual(sorted(item["id"] for item in report["references"]), ["angry", "neutral"])
        self.assertTrue(all(item["healthy"] for item in report["references"]))
        self.assertEqual(report["aliases"], {"生气": "angry", "平静": "neutral"})
        self.assertEqual(report["missing"], [])
        body = json.dumps(report, ensure_ascii=False)
        self.assertNotIn(str(self.root), body)
        self.assertEqual(report["fingerprint"], adapter.config_fingerprint(self.cfg))

    def test_capabilities_name_the_missing_reference(self):
        Path(self.refs["angry"]).unlink()
        report = adapter.capabilities(self.cfg)
        self.assertEqual(report["missing"], ["angry"])
        self.assertFalse([item for item in report["references"] if item["id"] == "angry"][0]["healthy"])

    def test_busy_engine_answers_instead_of_queueing(self):
        self.cfg["busy_wait_s"] = 0
        Path(adapter.CONFIG).write_text(json.dumps(self.cfg))
        adapter.ENGINE.acquire()
        try:
            with self.assertRaises(adapter.Busy):
                adapter.gpt_sovits_speech("Hello.", None, "neutral")
        finally:
            adapter.ENGINE.release()

    def serve_upstream(self):
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setparams((1, 2, 32000, 0, "NONE", "not compressed"))
            wav.writeframes(b"\0\0" * 320)
        audio = buffer.getvalue()

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200)
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return audio, server, thread

    def roundtrip(self, emotion, speed=None):
        captured = []
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setparams((1, 2, 32000, 0, "NONE", "not compressed"))
            wav.writeframes(b"\0\0" * 320)
        audio = buffer.getvalue()

        class Upstream(BaseHTTPRequestHandler):
            def do_POST(self):
                captured.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.send_header("Content-Length", str(len(audio)))
                self.end_headers()
                self.wfile.write(audio)

            def log_message(self, *_):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.cfg["gpt_sovits_url"] = "http://127.0.0.1:%d" % server.server_port
        Path(adapter.CONFIG).write_text(json.dumps(self.cfg))
        try:
            response, selected, fallback = adapter.gpt_sovits_speech("Hello.", speed, emotion)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        return captured[0], response, selected, fallback


if __name__ == "__main__":
    unittest.main()
