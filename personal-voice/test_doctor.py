"""doctor.sh 的只读检查：报告状态，不碰 LaunchAgent、不重启应用、不改安装目录以外的东西。"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
DOCTOR = HERE / "doctor.sh"

spec = importlib.util.spec_from_file_location("voice_patcher", HERE / "patch-streamvoice.py")
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.support = self.root / "support"
        self.voice = self.support / "tts"
        self.src = self.support / "extensions/node_modules/cortico-world-streamvoice/src"
        self.voice.mkdir(parents=True)
        self.src.mkdir(parents=True)
        # doctor 从它自己的目录调用补丁脚本，模板与清单也要在那儿
        for name in ("patch-streamvoice.py", "patch-manifest.json", "speaker.gptsovits.ts", "speech-plan.ts"):
            shutil.copy2(HERE / name, self.voice / name)
        upstream = {
            "clean.ts": "// clean\n",
            "chunker.ts": "// chunker\n",
            "speaker.ts": "// speaker\n",
        }
        world = ["// world\n"]
        for start, end, _ in patcher.WORLD_SPLICES:
            world.append(start + "\n")
            if end != start:
                world.append(end + "\n")
        upstream["world.ts"] = "".join(world)
        for name, text in upstream.items():
            (self.src / name).write_text(text, encoding="utf-8")
        (self.voice / "patch-manifest.json").write_text(json.dumps({
            "package": "cortico-world-streamvoice",
            "version": "0.4.0",
            "upstream": {name: digest(self.src / name) for name in upstream},
            "spliced": ["world.ts"],
            "written": {"speaker.ts": "speaker.gptsovits.ts", "speech-plan.ts": "speech-plan.ts"},
        }), encoding="utf-8")
        self.config = self.root / "adapter-config.json"
        self.config.write_text(json.dumps({
            "ref_audio_path": str(self.root / "ref/neutral.wav"),
            "emotion_refs": {
                "neutral": {"ref_audio_path": str(self.root / "ref/neutral.wav")},
                "angry": {"ref_audio_path": str(self.root / "ref/angry.wav")},
            },
        }), encoding="utf-8")

    def run_doctor(self, *args):
        env = dict(os.environ)
        env.update({
            "COOPANION_SUPPORT": str(self.support),
            "COOPANION_TTS_CONFIG": str(self.config),
            "COOPANION_STREAMVOICE_SRC": str(self.src),
            "COOPANION_GPT_URL": "http://127.0.0.1:1",
            "COOPANION_ADAPTER_URL": "http://127.0.0.1:1",
            "COOPANION_DOCTOR_NO_RESTART": "1",
        })
        return subprocess.run(["bash", str(DOCTOR), *args], capture_output=True, text=True, env=env)

    def test_check_reports_and_changes_nothing(self):
        before = {name: digest(self.src / name) for name in ("clean.ts", "chunker.ts", "speaker.ts", "world.ts")}
        result = self.run_doctor("--check")
        self.assertEqual(result.returncode, 1)
        self.assertIn("补丁状态：clean", result.stdout)
        self.assertIn("angry 参考音缺失", result.stdout)
        self.assertIn("不可用", result.stdout)
        self.assertEqual({name: digest(self.src / name) for name in before}, before)
        self.assertFalse((self.src / "speech-plan.ts").exists())
        self.assertFalse(list(self.support.glob("patch-transactions/*.json")))
        self.assertFalse(list(self.src.glob("*.bak-*")))

    def test_repair_applies_the_patch_without_restarting_anything(self):
        result = self.run_doctor("--repair")
        self.assertEqual(result.returncode, 1)
        self.assertTrue((self.src / "speech-plan.ts").is_file())
        self.assertIn("已按需应用补丁", result.stdout)
        self.assertIn("跳过应用重启", result.stdout)


if __name__ == "__main__":
    unittest.main()
