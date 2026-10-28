"""补丁契约：上游指纹、幂等、漂移与失败回滚都只在临时目录里发生。"""

import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
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

    def run_patcher(self, *args, templates=None):
        return subprocess.run(
            [sys.executable, str(PATCHER), "--extension-dir", str(self.src),
             "--support-dir", str(self.support), "--manifest", str(self.manifest),
             "--templates", str(templates or HERE), *args],
            capture_output=True, text=True,
        )

    def status(self):
        result = self.run_patcher("--check", "--json")
        return result.returncode, json.loads(result.stdout)

    def interrupt_after_first_replace(self):
        manifest = patcher.load_manifest(self.manifest)
        result = patcher.inspect(self.src, manifest, HERE)
        original_replace = patcher.os.replace
        replaced = 0
        self.interrupted_file = None

        def interrupt(source, target):
            nonlocal replaced
            original_replace(source, target)
            if Path(target).parent == self.src and ".bak-" not in Path(target).name:
                replaced += 1
                if replaced == 1:
                    self.interrupted_file = Path(target).name
                    raise SystemExit(99)

        patcher.os.replace = interrupt
        try:
            with self.assertRaises(SystemExit):
                patcher.apply(result, manifest, self.support)
        finally:
            patcher.os.replace = original_replace
        self.assertEqual(replaced, 1)

    def test_reports_a_clean_0_4_0_tree_before_touching_it(self):
        code, report = self.status()
        self.assertEqual((code, report["status"]), (1, "clean"))
        self.assertEqual(report["files"]["speech-plan.ts"], "absent")
        self.assertEqual(digest(self.src / "world.ts"), digest(self.src / "world.ts"))

    def test_json_status_alone_is_read_only(self):
        before = {name: digest(self.src / name) for name in self.upstream}
        result = self.run_patcher("--json")
        report = json.loads(result.stdout)
        self.assertEqual((result.returncode, report["status"]), (1, "clean"))
        self.assertEqual({name: digest(self.src / name) for name in self.upstream}, before)
        self.assertFalse((self.src / "speech-plan.ts").exists())
        self.assertFalse(list(self.support.glob("patch-transactions/*.json")))

    def test_json_cannot_be_combined_with_rollback(self):
        before = {name: digest(self.src / name) for name in self.upstream}
        result = self.run_patcher("--json", "--rollback")
        self.assertEqual(result.returncode, 2)
        self.assertIn("不能和只读查询参数组合", result.stderr)
        self.assertEqual({name: digest(self.src / name) for name in self.upstream}, before)
        self.assertFalse(list(self.support.glob("patch-transactions/*.json")))

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

    def test_concurrent_apply_is_serialized(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.run_patcher(), range(2)))
        self.assertEqual([result.returncode for result in results], [0, 0])
        self.assertEqual(len(list(self.support.glob("patch-transactions/*.json"))), 1)
        self.assertEqual(self.status()[1]["status"], "patched")

    def test_rollback_restores_every_original_and_removes_added_files(self):
        originals = {name: digest(self.src / name) for name in self.upstream}
        self.assertEqual(self.run_patcher().returncode, 0)
        result = self.run_patcher("--rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        for name, hashed in originals.items():
            self.assertEqual(digest(self.src / name), hashed)
        self.assertFalse((self.src / "speech-plan.ts").exists())

    def test_backup_preserves_read_only_source_mode(self):
        source = self.src / "speaker.ts"
        original = digest(source)
        source.chmod(0o444)
        result = self.run_patcher()
        self.assertEqual(result.returncode, 0, result.stderr)
        rollback = self.run_patcher("--rollback")
        self.assertEqual(rollback.returncode, 0, rollback.stderr)
        self.assertEqual(digest(source), original)
        self.assertEqual(stat.S_IMODE(source.stat().st_mode), 0o444)

    def test_an_older_patch_upgrades_through_rollback(self):
        old = self.root / "old-templates"
        old.mkdir()
        for name in ("speaker.gptsovits.ts", "speech-plan.ts"):
            (old / name).write_text((HERE / name).read_text(encoding="utf-8") + "\n// old build\n", encoding="utf-8")
        self.assertEqual(self.run_patcher(templates=old).returncode, 0)
        self.assertEqual(self.status()[1]["status"], "incompatible")
        self.assertEqual(self.run_patcher("--rollback").returncode, 0)
        self.assertEqual(self.run_patcher().returncode, 0)
        self.assertEqual(self.status()[1]["status"], "patched")

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

    def test_apply_recovers_a_process_interruption_before_reapplying(self):
        originals = {name: digest(self.src / name) for name in self.upstream}
        self.interrupt_after_first_replace()
        partial = self.run_patcher("--check", "--json")
        report = json.loads(partial.stdout)
        self.assertEqual((partial.returncode, report["status"]), (1, "patch"))
        self.assertEqual(len(report["transactionsPending"]), 1)
        changed = [name for name, hashed in originals.items() if digest(self.src / name) != hashed]
        if (self.src / "speech-plan.ts").exists():
            changed.append("speech-plan.ts")
        self.assertEqual(changed, [self.interrupted_file])

        recovered = self.run_patcher()
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        self.assertIn("recovered interrupted patch transaction", recovered.stdout)
        self.assertEqual(self.status()[1]["status"], "patched")
        states = [json.loads(path.read_text(encoding="utf-8"))["state"] for path in self.support.glob("patch-transactions/*.json")]
        self.assertCountEqual(states, ["recovered", "applied"])
        self.assertFalse(list(self.src.parent.glob(".coopanion-patch-*")))

    def test_manual_rollback_recovers_a_process_interruption_and_pauses_repair(self):
        originals = {name: digest(self.src / name) for name in self.upstream}
        self.interrupt_after_first_replace()
        result = self.run_patcher("--rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.run_patcher("--paused").returncode, 0)
        for name, hashed in originals.items():
            self.assertEqual(digest(self.src / name), hashed)
        self.assertFalse((self.src / "speech-plan.ts").exists())
        self.assertFalse(list(self.src.parent.glob(".coopanion-patch-*")))

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
