"""Lifecycle tests for the isolated voice runtime; every fixture lives under scratch."""

import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SPEC = importlib.util.spec_from_file_location("voice_runtime", HERE / "runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def free_ports(count=2):
    found = []
    for port in range(19000, 20000):
        if len(found) == count:
            break
        probe = socket.socket()
        try:
            probe.bind(("127.0.0.1", port))
            found.append(port)
        except OSError:
            pass
        finally:
            probe.close()
    if len(found) != count:
        raise RuntimeError("no free test ports")
    return found


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        (REPO / "scratch").mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="voice-runtime-test-", dir=REPO / "scratch")
        self.addCleanup(self.temp.cleanup)
        self.container = Path(self.temp.name)
        self.run_id = "r1-voice-20261028-test"
        self.run_container = self.container / self.run_id
        self.run_container.mkdir(mode=0o700)
        self.root = self.run_container / "runtime"
        self.home = self.container / "home"
        self.home.mkdir()
        self.source = self.container / "source"
        self.source.mkdir()
        self.assets = self.run_container / "assets"
        self.assets.mkdir()
        self.reference = self.assets / "neutral.wav"
        self.reference.write_bytes(b"synthetic reference placeholder")
        self.reference.chmod(0o400)
        self.ports = free_ports()
        self.server = self.source / "health_server.py"
        self.server.write_text(
            "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
            "import sys\n"
            "path = sys.argv[2]\n"
            "class H(BaseHTTPRequestHandler):\n"
            " def do_GET(self):\n"
            "  body=b'ok' if self.path == path else b'no'\n"
            "  self.send_response(200 if body == b'ok' else 404)\n"
            "  self.send_header('Content-Length', str(len(body)))\n"
            "  self.end_headers(); self.wfile.write(body)\n"
            " def log_message(self, *args): pass\n"
            "HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()\n",
            encoding="utf-8",
        )
        self.config = self.source / "adapter-config.json"
        self.config.write_text(json.dumps({
            "adapter_port": self.ports[1],
            "gpt_sovits_url": f"http://127.0.0.1:{self.ports[0]}",
            "ref_audio_path": str(self.reference),
        }), encoding="utf-8")
        python = Path(sys.executable).resolve()
        self.spec_path = self.container / "runtime-spec.json"
        self.spec = {
            "schemaVersion": 1,
            "runId": self.run_id,
            "root": str(self.root),
            "ports": {"engine": self.ports[0], "adapter": self.ports[1]},
            "python": {"executable": str(python), "version": runtime.python_version(python)},
            "files": [
                {"source": str(self.server), "target": "service/health_server.py",
                 "sha256": runtime.sha256_file(self.server)},
                {"source": str(self.config), "target": "adapter-config.json",
                 "sha256": runtime.sha256_file(self.config)},
            ],
            "readOnlyAssets": [{"path": str(self.reference), "sha256": runtime.sha256_file(self.reference)}],
            "processes": [
                {"id": "engine", "argv": ["{python}", "{root}/service/health_server.py", "{port:engine}", "/docs"],
                 "cwd": "{root}/service", "env": {}, "healthUrl": f"http://127.0.0.1:{self.ports[0]}/docs", "startupTimeoutSec": 10},
                {"id": "adapter", "argv": ["{python}", "{root}/service/health_server.py", "{port:adapter}", "/health"],
                 "cwd": "{root}/service", "env": {}, "healthUrl": f"http://127.0.0.1:{self.ports[1]}/health", "startupTimeoutSec": 10},
            ],
        }
        self.write_spec()
        self.options = {"home": self.home, "repo_root": REPO, "test_roots": (self.run_container,)}

    def write_spec(self):
        self.spec_path.write_text(json.dumps(self.spec, indent=2), encoding="utf-8")

    def test_plan_is_read_only_and_refuses_production_ports(self):
        planned = runtime.plan(self.spec_path, **self.options)
        self.assertEqual(planned["result"], "READY_TO_STAGE")
        self.assertFalse(planned["writes"])
        self.assertFalse(self.root.exists())

        self.spec["ports"]["engine"] = 9880
        self.write_spec()
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "生产端口"):
            runtime.plan(self.spec_path, **self.options)
        self.assertFalse(self.root.exists())

    def test_rejects_secret_fields_and_assets_outside_this_run(self):
        self.spec["apiKey"] = "must-not-be-stored"
        self.write_spec()
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "密钥"):
            runtime.read_spec(self.spec_path, **self.options)

        self.spec.pop("apiKey")
        self.spec["readOnlyAssets"][0]["path"] = str(Path.home() / "voice.wav")
        self.write_spec()
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "本次 run"):
            runtime.read_spec(self.spec_path, **self.options)

    def test_stage_check_start_stop_and_rollback_keep_read_only_assets(self):
        staged = runtime.stage(self.spec_path, **self.options)
        self.assertEqual(staged["result"], "STAGED")
        self.assertEqual(runtime.check(str(self.root), self.run_id, **self.options)["result"], "READY")

        started = runtime.start_test(str(self.root), self.run_id, **self.options)
        self.assertEqual(started["result"], "RUNNING")
        self.assertEqual(set(started["processes"]), {"engine", "adapter"})
        self.assertEqual(runtime.check(str(self.root), self.run_id, **self.options)["result"], "READY")

        stopped = runtime.stop_test(str(self.root), self.run_id, **self.options)
        self.assertEqual(stopped["result"], "STOPPED")
        self.assertCountEqual(stopped["stopped"], ["engine", "adapter"])

        rollback = runtime.rollback(str(self.root), self.run_id, **self.options)
        self.assertEqual(rollback["result"], "ROLLED_BACK")
        self.assertTrue(self.reference.is_file())
        self.assertFalse((self.root / "service/health_server.py").exists())
        self.assertTrue(rollback["logsPreserved"])

    def test_rollback_preserves_modified_stage_files(self):
        runtime.stage(self.spec_path, **self.options)
        staged = self.root / "service/health_server.py"
        staged.write_text("changed by operator\n", encoding="utf-8")
        rollback = runtime.rollback(str(self.root), self.run_id, **self.options)
        self.assertEqual(rollback["result"], "ROLLED_BACK_WITH_PRESERVED_FILES")
        self.assertEqual(rollback["preservedChangedFiles"], ["service/health_server.py"])
        self.assertTrue(staged.is_file())
        self.assertTrue(self.reference.is_file())

    def test_stage_refuses_a_symlink_source(self):
        link = self.source / "linked.py"
        link.symlink_to(self.server)
        self.spec["files"][0]["source"] = str(link)
        self.write_spec()
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "符号链接"):
            runtime.stage(self.spec_path, **self.options)
        self.assertFalse(self.root.exists())

    def test_requires_absolute_sources_and_nonempty_relative_targets(self):
        self.spec["files"][0]["source"] = "relative.py"
        self.write_spec()
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "绝对路径"):
            runtime.read_spec(self.spec_path, **self.options)

        self.spec["files"][0]["source"] = str(self.server)
        self.spec["files"][0]["target"] = "."
        self.write_spec()
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "相对路径"):
            runtime.read_spec(self.spec_path, **self.options)

    def test_manifest_tampering_is_rejected_before_check_or_start(self):
        runtime.stage(self.spec_path, **self.options)
        manifest_path = self.root / runtime.RUNTIME_MANIFEST
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["ports"]["engine"] = 9881
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(runtime.RuntimeErrorSafe):
            runtime.start_test(str(self.root), self.run_id, **self.options)
        self.assertFalse((self.root / runtime.PROCESS_STATE).exists())

    def test_rollback_does_not_follow_symlinked_stage_parent(self):
        runtime.stage(self.spec_path, **self.options)
        service = self.root / "service"
        staged = service / "health_server.py"
        staged.unlink()
        service.rmdir()
        service.symlink_to(self.source, target_is_directory=True)

        rollback = runtime.rollback(str(self.root), self.run_id, **self.options)

        self.assertEqual(rollback["result"], "ROLLED_BACK_WITH_PRESERVED_FILES")
        self.assertEqual(rollback["preservedChangedFiles"], ["service/health_server.py"])
        self.assertTrue(self.server.is_file())
        self.assertEqual(runtime.sha256_file(self.server), self.spec["files"][0]["sha256"])

    def test_read_only_asset_rejects_a_hard_link(self):
        alias = self.assets / "linked-neutral.wav"
        os.link(self.reference, alias)
        self.spec["readOnlyAssets"][0]["path"] = str(alias)
        self.write_spec()
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "本次 run"):
            runtime.read_spec(self.spec_path, **self.options)

    def test_runtime_root_must_be_inside_the_requested_run(self):
        outside = self.container / "unrelated" / "runtime"
        with self.assertRaisesRegex(runtime.RuntimeErrorSafe, "runId 专属"):
            runtime.check(str(outside), self.run_id, **self.options)


if __name__ == "__main__":
    unittest.main()
