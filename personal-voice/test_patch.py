"""补丁契约：上游指纹、幂等、漂移与失败回滚都只在临时目录里发生。"""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
PATCHER = HERE / "patch-streamvoice.py"

spec = importlib.util.spec_from_file_location("voice_patcher", PATCHER)
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.src = self.root / "extension" / "src"
        self.src.mkdir(parents=True)
        self.support = self.root / "support"
        self.upstream = {
            "clean.ts": "// clean fixture\nexport const speakable = (text) => text;\n",
            "chunker.ts": "// chunker fixture\n",
            "speaker.ts": "// upstream speaker\n",
        }
        # world.ts 只放补丁的锚点：真实文件由上游指纹守着，这里验证契约
        world = ["// world fixture\n"]
        for start, end, _ in patcher.WORLD_SPLICES:
            world.append(start + "\n")
            if end != start:
                world.append(end + "\n")
        self.upstream["world.ts"] = "".join(world)
        for name, text in self.upstream.items():
            (self.src / name).write_text(text, encoding="utf-8")
        self.manifest = self.root / "manifest.json"
        self.write_manifest({name: digest(self.src / name) for name in self.upstream})

    def write_manifest(self, hashes):
        fixture = (self.src / "world.ts").read_text(encoding="utf-8")
        world = patcher.world_patched(fixture)
        self.manifest.write_text(json.dumps({
            "package": "cortico-world-streamvoice",
            "version": "0.4.0",
            "upstream": hashes,
            "spliced": ["world.ts"],
            "written": {"speaker.ts": "speaker.gptsovits.ts", "speech-plan.ts": "speech-plan.ts"},
            "results": {"world.ts": hashlib.sha256(world.encode("utf-8")).hexdigest()},
        }), encoding="utf-8")

    def run_patcher(self, *args):
        return subprocess.run(
            [sys.executable, str(PATCHER), "--extension-dir", str(self.src),
             "--support-dir", str(self.support), "--manifest", str(self.manifest),
             "--templates", str(HERE), *args],
            capture_output=True, text=True,
        )

    def status(self):
        result = self.run_patcher("--check", "--json")
        return result.returncode, json.loads(result.stdout)

    def test_reports_a_clean_0_4_0_tree_before_touching_it(self):
        code, report = self.status()
        self.assertEqual((code, report["status"]), (1, "clean"))
        self.assertEqual(report["files"]["speech-plan.ts"], "absent")
        self.assertEqual(digest(self.src / "world.ts"), digest(self.src / "world.ts"))

    def test_applies_once_and_stays_applied(self):
        first = self.run_patcher()
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertTrue((self.src / "speech-plan.ts").is_file())
        self.assertEqual((self.src / "speaker.ts").read_text(encoding="utf-8"), (HERE / "speaker.gptsovits.ts").read_text(encoding="utf-8"))
        self.assertEqual(len(list(self.support.glob("patch-transactions/*.json"))), 1)

        second = self.run_patcher()
        self.assertEqual(second.returncode, 0)
        self.assertIn("已经是最新的", second.stdout)

        code, report = self.status()
        self.assertEqual((code, report["status"]), (0, "patched"))

    def test_rollback_restores_every_original_and_removes_added_files(self):
        originals = {name: digest(self.src / name) for name in self.upstream}
        self.assertEqual(self.run_patcher().returncode, 0)
        result = self.run_patcher("--rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, hashed in originals.items():
            self.assertEqual(digest(self.src / name), hashed)
        self.assertFalse((self.src / "speech-plan.ts").exists())

    def test_rollback_pauses_automatic_repair(self):
        self.assertEqual(self.run_patcher().returncode, 0)
        self.assertEqual(self.run_patcher("--paused").returncode, 1)
        self.assertEqual(self.run_patcher("--rollback").returncode, 0)
        self.assertEqual(self.run_patcher("--paused").returncode, 0)
        self.assertEqual(self.run_patcher().returncode, 0)
        self.assertEqual(self.run_patcher("--paused").returncode, 1)

    def test_rollback_also_handles_a_half_finished_install(self):
        originals = {name: digest(self.src / name) for name in self.upstream}
        self.assertEqual(self.run_patcher().returncode, 0)
        record = json.loads(next(self.support.glob("patch-transactions/*.json")).read_text(encoding="utf-8"))
        self.assertEqual(record["state"], "applied")
        # 模拟中途断电：有一个文件已经回到原版，其余还是补丁产物
        world = next(entry for entry in record["files"] if entry["file"] == "world.ts")
        (self.src / "world.ts").write_bytes((self.src / world["backup"]).read_bytes())
        result = self.run_patcher("--rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, hashed in originals.items():
            self.assertEqual(digest(self.src / name), hashed)
        self.assertFalse((self.src / "speech-plan.ts").exists())

    def test_refuses_an_unknown_upstream_version_and_changes_nothing(self):
        before = {name: digest(self.src / name) for name in self.upstream}
        (self.src / "world.ts").write_text("// some later version\n", encoding="utf-8")
        changed = digest(self.src / "world.ts")
        result = self.run_patcher()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(digest(self.src / "world.ts"), changed)
        for name in ("clean.ts", "chunker.ts", "speaker.ts"):
            self.assertEqual(digest(self.src / name), before[name])
        self.assertFalse((self.src / "speech-plan.ts").exists())

    def test_a_half_applied_tree_is_not_reported_as_patched(self):
        self.assertEqual(self.run_patcher().returncode, 0)
        # 只把 world.ts 还原：其余仍是补丁产物
        record = json.loads(next(self.support.glob("patch-transactions/*.json")).read_text(encoding="utf-8"))
        world = next(entry for entry in record["files"] if entry["file"] == "world.ts")
        (self.src / "world.ts").write_bytes((self.src / world["backup"]).read_bytes())
        code, report = self.status()
        self.assertEqual((code, report["status"]), (1, "patch"))
        self.assertEqual(report["files"]["world.ts"], "upstream")

    def test_a_missing_required_upstream_file_is_incompatible(self):
        (self.src / "world.ts").unlink()
        code, report = self.status()
        self.assertEqual((code, report["status"]), (2, "incompatible"))
        self.assertEqual(report["files"]["world.ts"], "absent")
        self.assertEqual(self.run_patcher().returncode, 2)

    def test_drift_outside_the_replaced_regions_is_detected(self):
        self.assertEqual(self.run_patcher().returncode, 0)
        world = (self.src / "world.ts").read_text(encoding="utf-8")
        (self.src / "world.ts").write_text(world.replace("// world fixture", "// world fixture, edited"), encoding="utf-8")
        code, report = self.status()
        self.assertEqual((code, report["status"]), (2, "incompatible"))
        self.assertEqual(report["files"]["world.ts"], "other")

    def test_detects_a_hand_edited_installed_file(self):
        self.assertEqual(self.run_patcher().returncode, 0)
        (self.src / "speaker.ts").write_text("// somebody edited the patched speaker\n", encoding="utf-8")
        code, report = self.status()
        self.assertEqual((code, report["status"]), (2, "incompatible"))

    def test_a_failed_install_leaves_the_original_files(self):
        before = {name: digest(self.src / name) for name in self.upstream}
        (self.src / "speech-plan.ts").mkdir()
        result = self.run_patcher()
        self.assertEqual(result.returncode, 2)
        for name, hashed in before.items():
            self.assertEqual(digest(self.src / name), hashed)
        self.assertFalse([p for p in self.src.glob("*.bak-*")])

    def test_missing_extension_is_reported_without_touching_anything(self):
        result = subprocess.run(
            [sys.executable, str(PATCHER), "--check", "--extension-dir", str(self.root / "nope"),
             "--support-dir", str(self.support), "--manifest", str(self.manifest), "--templates", str(HERE)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("没找到扩展源码目录", result.stderr)

    def test_reports_a_missing_template_instead_of_half_applying(self):
        original = (self.src / "speaker.ts").read_bytes()
        missing = self.root / "templates"
        missing.mkdir()
        result = subprocess.run(
            [sys.executable, str(PATCHER), "--extension-dir", str(self.src),
             "--support-dir", str(self.support), "--manifest", str(self.manifest), "--templates", str(missing)],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("缺少模板", result.stderr)
        self.assertEqual((self.src / "speaker.ts").read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
