"""Contract tests for explicit emotion selection and local inference requests."""

import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


spec = importlib.util.spec_from_file_location("voice_adapter", Path(__file__).with_name("adapter.py"))
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        original = adapter.CONFIG
        adapter.CONFIG = str(Path(self.temp.name) / "adapter.json")
        self.addCleanup(setattr, adapter, "CONFIG", original)
        self.cfg = {
            "ref_audio_path": "/fixtures/default.wav", "prompt_text": "Default reference.",
            "default_emotion": "neutral", "emotion_aliases": {"生气": "angry", "平静": "neutral"},
            "emotion_refs": {
                "neutral": {"ref_audio_path": "/fixtures/neutral.wav", "prompt_text": "Neutral reference."},
                "angry": {"ref_audio_path": "/fixtures/angry.wav", "prompt_text": "Angry reference."},
            },
            "emotion_keywords": {"angry": ["生气", "!"]},
        }

    def test_body_words_do_not_override_unspecified_or_unrecognized_emotion(self):
        for mood in (None, "", "unrecognized"):
            self.assertEqual(adapter.pick_emotion(self.cfg, "不要生气!", mood), "neutral")

    def test_explicit_emotion_wins_over_opted_in_keyword_fallback(self):
        self.cfg["emotion_keyword_fallback"] = True
        self.assertEqual(adapter.pick_emotion(self.cfg, "不要生气!", "neutral"), "neutral")
        self.assertEqual(adapter.pick_emotion(self.cfg, "不要生气!", None), "angry")

    def test_chinese_alias_in_combined_action_marker_selects_reference(self):
        self.assertEqual(adapter.pick_emotion(self.cfg, "Hello.", "【生气，甩尾巴】"), "angry")

    def test_legacy_single_reference_configuration_still_works(self):
        self.cfg.pop("emotion_refs")
        self.assertIsNone(adapter.pick_emotion(self.cfg, "Hello.", "angry"))
        payload, audio, emotion = self.roundtrip("angry")
        self.assertEqual(payload["ref_audio_path"], "/fixtures/default.wav")
        self.assertEqual(audio[:4], b"RIFF")
        self.assertIsNone(emotion)
        self.assertNotIn("aux_ref_audio_paths", payload)

    def test_emotion_overrides_auxiliary_reference_and_sampling_without_changing_text(self):
        self.cfg.update(aux_ref_audio_paths=["/fixtures/global.wav"], temperature=1.0, seed=42, top_k=15)
        self.cfg["emotion_refs"]["angry"].update(aux_ref_audio_paths=[], temperature=.7, top_k=10)
        payload, audio, emotion = self.roundtrip("angry")
        self.assertEqual(payload["ref_audio_path"], "/fixtures/angry.wav")
        self.assertEqual(payload["aux_ref_audio_paths"], [])
        self.assertEqual((payload["temperature"], payload["top_k"], payload["seed"]), (.7, 10, 42))
        self.assertEqual(payload["text"], "Hello.")
        self.assertEqual((audio[:4], emotion), (b"RIFF", "angry"))

    def test_emotion_inherits_fixed_timbre_reference_and_explicit_speed(self):
        self.cfg.update(aux_ref_audio_paths=["/fixtures/anchor.wav"], top_p=.9, parallel_infer=False)
        payload, _, _ = self.roundtrip("neutral", speed=1.1)
        self.assertEqual(payload["aux_ref_audio_paths"], ["/fixtures/anchor.wav"])
        self.assertEqual((payload["top_p"], payload["parallel_infer"], payload["speed_factor"]), (.9, False, 1.1))

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
            response, selected = adapter.gpt_sovits_speech("Hello.", speed, emotion)
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        return captured[0], response, selected


if __name__ == "__main__":
    unittest.main()
