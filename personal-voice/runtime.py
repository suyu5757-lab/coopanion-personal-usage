#!/usr/bin/env python3
"""Manage one isolated, manifest-owned Coopanion voice runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
PRODUCTION_ROOT = Path.home() / "Library/Application Support/Coopanion"
RUNTIME_MANIFEST = "voice-runtime-manifest.json"
PROCESS_STATE = "voice-runtime-processes.json"
RUN_ID = re.compile(r"^r1-[a-z0-9][a-z0-9-]{5,48}$")
PORT_MIN = 19000
PORT_MAX = 19999
FORBIDDEN_COMMANDS = {"launchctl", "osascript", "open", "sh", "bash", "zsh", "fish"}
SAFE_ENV_KEYS = {"PYTHONPATH", "VIRTUAL_ENV", "COOPANION_TTS_CONFIG", "COOPANION_TTS_URL",
                 "COOPANION_GPT_URL", "COOPANION_SUPPORT", "COOPANION_STREAMVOICE_SRC"}
SECRET_KEY = re.compile(r"key|token|secret|password|credential", re.I)
SECRET_VALUE = re.compile(r"(?:api[_-]?key|token|secret|password|credential)\s*[:=]", re.I)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
PRODUCTION_PORT = re.compile(r"(?<!\d)988[01](?!\d)")
DETACHED_HANDLES: dict[int, subprocess.Popen[bytes]] = {}


class RuntimeErrorSafe(Exception):
    """An invalid or unsafe runtime specification."""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json_private(path: Path, value: dict[str, Any]) -> None:
    reject_symlink_components(path.parent)
    if path.is_symlink():
        raise RuntimeErrorSafe(f"拒绝覆盖符号链接：{path.name}")
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def is_within(path: Path, parent: Path) -> bool:
    path = Path(os.path.abspath(path))
    parent = Path(os.path.abspath(parent))
    try:
        relative = path.relative_to(parent)
        return path != parent and ".." not in relative.parts
    except ValueError:
        return False


def reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        try:
            if current.is_symlink():
                raise RuntimeErrorSafe(f"符号链接不允许用于 Runtime 路径：{current.name}")
        except OSError as error:
            raise RuntimeErrorSafe(f"无法检查路径组件：{current.name}") from error


def safe_relative(value: Any, field: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeErrorSafe(f"{field} 必须是相对路径")
    path = Path(value)
    if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
        raise RuntimeErrorSafe(f"{field} 必须是非空相对路径并留在 Runtime 目录内")
    return path


def allowed_runtime_root(root: Path, run_id: str, home: Path, repo_root: Path,
                         test_roots: tuple[Path, ...] | None = None) -> tuple[Path, Path]:
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise RuntimeErrorSafe("runId 格式无效")
    root = Path(os.path.abspath(root))
    production = Path(os.path.abspath(home / "Library/Application Support/Coopanion"))
    if root == production or is_within(root, production):
        raise RuntimeErrorSafe("Runtime 路径不能位于正式 Coopanion 支持目录")
    roots = test_roots or (
        home / "Library/Application Support/Coopanion Test" / run_id,
        repo_root / "scratch" / run_id,
    )
    resolved_roots = tuple(Path(os.path.abspath(item)) for item in roots)
    for container in resolved_roots:
        if root.parent == container:
            reject_symlink_components(container)
            reject_symlink_components(root)
            return root, container
    raise RuntimeErrorSafe("Runtime 必须是 runId 专属 Coopanion Test 或 scratch 目录的直接子目录")


def reject_secret_keys(value: Any, prefix: str = "spec") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if SECRET_KEY.search(str(key)):
                raise RuntimeErrorSafe(f"{prefix} 不能保存密钥或凭据字段")
            reject_secret_keys(child, f"{prefix}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            reject_secret_keys(child, f"{prefix}[{index}]")


def _validate_runtime_env(env: Any, root: Path, container: Path, ports: dict[str, int]) -> dict[str, str]:
    if not isinstance(env, dict) or any(key not in SAFE_ENV_KEYS for key in env):
        raise RuntimeErrorSafe("进程环境变量超出 Runtime 白名单")
    normalized: dict[str, str] = {}
    path_keys = {"PYTHONPATH", "VIRTUAL_ENV", "COOPANION_TTS_CONFIG", "COOPANION_SUPPORT", "COOPANION_STREAMVOICE_SRC"}
    for key, value in env.items():
        if not isinstance(value, str) or SECRET_VALUE.search(value) or PRODUCTION_PORT.search(value):
            raise RuntimeErrorSafe(f"进程环境变量 {key} 含有密钥或生产端口")
        if key in path_keys:
            if value.startswith("{root}/"):
                safe_relative(value[len("{root}/"):], f"process.env.{key}")
                normalized[key] = value
                continue
            path = Path(os.path.abspath(value))
            if not Path(value).is_absolute() or not (is_within(path, root) or is_within(path, container)):
                raise RuntimeErrorSafe(f"进程环境变量 {key} 必须留在隔离 Runtime 内")
            reject_symlink_components(path)
            normalized[key] = str(path)
            continue
        expanded = value.replace("{port:engine}", str(ports["engine"])) \
            .replace("{port:adapter}", str(ports["adapter"]))
        try:
            endpoint = urllib.parse.urlsplit(expanded)
            endpoint_port = endpoint.port
        except ValueError as error:
            raise RuntimeErrorSafe(f"進程環境變量 {key} URL 格式無效") from error
        if (endpoint.scheme != "http" or endpoint.hostname != "127.0.0.1"
                or endpoint_port not in set(ports.values())):
            raise RuntimeErrorSafe(f"进程环境变量 {key} 只能指向专用本机端口")
        normalized[key] = value
    return normalized


def read_spec(path: Path, home: Path | None = None, repo_root: Path | None = None,
              test_roots: tuple[Path, ...] | None = None) -> tuple[dict[str, Any], Path, Path]:
    path = Path(os.path.abspath(path))
    reject_symlink_components(path)
    if not path.is_file():
        raise RuntimeErrorSafe("Runtime 计划必须是普通文件")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeErrorSafe(f"读取 Runtime 计划失败：{type(error).__name__}") from error
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise RuntimeErrorSafe("Runtime 计划版本必须是 1")
    reject_secret_keys(raw)
    run_id = raw.get("runId")
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise RuntimeErrorSafe("runId 格式无效")
    if home is None:
        home = Path.home()
    if repo_root is None:
        repo_root = REPO_ROOT
    raw_root = raw.get("root")
    if not isinstance(raw_root, str) or not Path(raw_root).is_absolute():
        raise RuntimeErrorSafe("root 必须是绝对路径")
    root, container = allowed_runtime_root(Path(raw_root), run_id, home, repo_root, test_roots)
    ports = raw.get("ports")
    if not isinstance(ports, dict) or set(ports) != {"engine", "adapter"}:
        raise RuntimeErrorSafe("ports 必须包含 engine 与 adapter")
    port_values = list(ports.values())
    if any(type(port) is not int for port in port_values):
        raise RuntimeErrorSafe("测试端口必须为整数")
    if 9880 in port_values or 9881 in port_values:
        raise RuntimeErrorSafe("不能使用生产端口 9880/9881")
    if any(not PORT_MIN <= port <= PORT_MAX for port in port_values):
        raise RuntimeErrorSafe(f"测试端口必须在 {PORT_MIN}–{PORT_MAX} 范围内")
    if len(set(port_values)) != 2:
        raise RuntimeErrorSafe("测试端口必须互不相同")
    python = raw.get("python")
    if not isinstance(python, dict) or not isinstance(python.get("executable"), str) or not Path(python["executable"]).is_absolute():
        raise RuntimeErrorSafe("python.executable 必须是绝对路径")
    try:
        python_path = Path(python["executable"]).resolve(strict=True)
    except OSError as error:
        raise RuntimeErrorSafe("指定的 Python 不存在或不可解析") from error
    if is_within(python_path, Path(os.path.abspath(home / "Library/Application Support/Coopanion"))):
        raise RuntimeErrorSafe("Python 不能位于正式 Coopanion 支持目录")
    if not python_path.is_file() or not os.access(python_path, os.X_OK):
        raise RuntimeErrorSafe("指定的 Python 不存在或不可执行")
    python["executable"] = str(python_path)
    expected_python = python.get("version")
    if not isinstance(expected_python, str) or not re.fullmatch(r"\d+\.\d+\.\d+", expected_python):
        raise RuntimeErrorSafe("python.version 必须记录完整版本号")
    copy_files = raw.get("files")
    if not isinstance(copy_files, list) or not copy_files:
        raise RuntimeErrorSafe("files 必须列出至少一个要分阶段复制的文件")
    targets: set[str] = set()
    reserved_targets = {RUNTIME_MANIFEST, PROCESS_STATE, "home", "tmp", "logs"}
    for index, entry in enumerate(copy_files):
        if not isinstance(entry, dict) or not isinstance(entry.get("source"), str):
            raise RuntimeErrorSafe(f"files[{index}] 缺少 source")
        source = Path(entry["source"])
        if not source.is_absolute():
            raise RuntimeErrorSafe(f"files[{index}].source 必须是绝对路径")
        source = Path(os.path.abspath(source))
        entry["source"] = str(source)
        reject_symlink_components(source)
        if source == PRODUCTION_ROOT or is_within(source, Path(os.path.abspath(home / "Library/Application Support/Coopanion"))):
            raise RuntimeErrorSafe("不能从正式 Coopanion 目录分阶段复制文件")
        try:
            source_stat = source.lstat()
        except OSError as error:
            raise RuntimeErrorSafe(f"files[{index}].source 不可读取") from error
        if not stat.S_ISREG(source_stat.st_mode):
            raise RuntimeErrorSafe(f"files[{index}].source 不是普通文件")
        if not isinstance(entry.get("sha256"), str) or not SHA256.fullmatch(entry["sha256"]):
            raise RuntimeErrorSafe(f"files[{index}].sha256 必须是固定的 SHA-256")
        target = safe_relative(entry.get("target"), f"files[{index}].target")
        if target.parts[0] in reserved_targets:
            raise RuntimeErrorSafe("files.target 不能占用 Runtime 管理目录或清单文件")
        if target.as_posix() in targets:
            raise RuntimeErrorSafe("files 中不能有重复 target")
        targets.add(target.as_posix())
    assets = raw.get("readOnlyAssets", [])
    if not isinstance(assets, list) or not assets:
        raise RuntimeErrorSafe("readOnlyAssets 必须列出隔离运行所需的参考资产")
    for index, asset in enumerate(assets):
        if not isinstance(asset, dict) or not isinstance(asset.get("path"), str):
            raise RuntimeErrorSafe(f"readOnlyAssets[{index}] 缺少 path")
        asset_path = Path(asset["path"])
        if not asset_path.is_absolute():
            raise RuntimeErrorSafe(f"readOnlyAssets[{index}].path 必须是绝对路径")
        asset_path = Path(os.path.abspath(asset_path))
        asset["path"] = str(asset_path)
        reject_symlink_components(asset_path)
        try:
            asset_stat = asset_path.lstat()
        except OSError as error:
            raise RuntimeErrorSafe("只读资产必须位于本次 run 专属目录，且为普通文件") from error
        if (not stat.S_ISREG(asset_stat.st_mode) or not is_within(Path(os.path.abspath(asset_path)), container)
                or asset_stat.st_nlink != 1 or asset_stat.st_mode & 0o222):
            raise RuntimeErrorSafe("只读模型/参考音必须位于本次 run 专属目录，且为普通文件")
        if not isinstance(asset.get("sha256"), str) or not SHA256.fullmatch(asset["sha256"]):
            raise RuntimeErrorSafe(f"readOnlyAssets[{index}].sha256 必须是固定的 SHA-256")
        if sha256_file(asset_path) != asset["sha256"]:
            raise RuntimeErrorSafe(f"只读资产哈希不匹配：{asset_path.name}")
    processes = raw.get("processes")
    if not isinstance(processes, list) or len(processes) != 2:
        raise RuntimeErrorSafe("processes 必须列出 engine 与 adapter 两个进程")
    if [item.get("id") if isinstance(item, dict) else None for item in processes] != ["engine", "adapter"]:
        raise RuntimeErrorSafe("processes 顺序固定为 engine、adapter")
    for process in processes:
        argv = process.get("argv")
        if not isinstance(argv, list) or len(argv) < 2 or argv[0] != "{python}":
            raise RuntimeErrorSafe("进程只能通过已记录的 Python 解释器启动脚本，不能使用 shell")
        if not isinstance(argv[1], str) or not argv[1].startswith("{root}/") or not argv[1].endswith(".py"):
            raise RuntimeErrorSafe("进程入口必须是 Runtime 目录内的 Python 脚本")
        script_target = safe_relative(argv[1][len("{root}/"):], "process.argv[1]").as_posix()
        if script_target not in targets:
            raise RuntimeErrorSafe("进程入口必须对应一个已固定哈希的 stage 文件")
        production_path = str(Path(os.path.abspath(home / "Library/Application Support/Coopanion")))
        if any(not isinstance(arg, str) or arg.lower() in FORBIDDEN_COMMANDS
               or PRODUCTION_PORT.search(arg) or "cooperation.app" in arg.lower()
               or production_path in arg for arg in argv):
            raise RuntimeErrorSafe("进程参数包含禁止的安装版控制命令")
        cwd = process.get("cwd")
        if not isinstance(cwd, str) or not cwd.startswith("{root}/"):
            raise RuntimeErrorSafe("进程 cwd 必须位于 Runtime 目录内")
        safe_relative(cwd[len("{root}/"):], "process.cwd")
        process["env"] = _validate_runtime_env(process.get("env", {}), root, container, ports)
        try:
            health = urllib.parse.urlsplit(str(process.get("healthUrl", "")))
            health_port = health.port
        except ValueError as error:
            raise RuntimeErrorSafe("healthUrl 格式无效") from error
        expected_port = ports[process["id"]]
        if (health.scheme != "http" or health.hostname != "127.0.0.1" or health_port != expected_port
                or health.username is not None or health.password is not None):
            raise RuntimeErrorSafe("healthUrl 必须指向该进程专属的本机测试端口")
        timeout = process.get("startupTimeoutSec", 60)
        if type(timeout) is not int or not 1 <= timeout <= 300:
            raise RuntimeErrorSafe("startupTimeoutSec 必须在 1–300 秒范围内")
    return raw, root, container


def python_version(executable: Path) -> str:
    try:
        result = subprocess.run([str(executable), "--version"], capture_output=True, text=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeErrorSafe("无法读取指定 Python 的版本") from error
    text = (result.stdout or result.stderr).strip()
    match = re.search(r"Python\s+(\d+\.\d+\.\d+)", text)
    if not match:
        raise RuntimeErrorSafe("Python --version 输出无法识别")
    return match.group(1)


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        try:
            server.bind(("127.0.0.1", port))
            server.listen(1)
            return True
        except OSError:
            return False


def plan(spec_path: Path, **options: Any) -> dict[str, Any]:
    spec, root, container = read_spec(spec_path, **options)
    python = Path(spec["python"]["executable"])
    version = python_version(python)
    expected = spec["python"]["version"]
    files = []
    for entry in spec["files"]:
        source = Path(entry["source"])
        digest = sha256_file(source)
        expected_digest = entry.get("sha256")
        files.append({"target": entry["target"], "bytes": source.stat().st_size,
                      "sha256": digest, "matchesExpected": expected_digest in (None, digest)})
    assets = []
    for asset in spec.get("readOnlyAssets", []):
        path = Path(asset["path"])
        digest = sha256_file(path)
        assets.append({"name": path.name, "bytes": path.stat().st_size,
                       "sha256": digest, "matchesExpected": asset.get("sha256") in (None, digest)})
    ports = {name: {"port": port, "free": port_free(port)} for name, port in spec["ports"].items()}
    problems = []
    if version != expected: problems.append("python-version-mismatch")
    if root.exists() or root.is_symlink(): problems.append("runtime-root-already-exists")
    if container.is_symlink() or (container.exists() and not container.is_dir()):
        problems.append("run-container-not-a-directory")
    elif container.exists() and stat.S_IMODE(container.stat().st_mode) & 0o077:
        problems.append("run-container-permissions-too-broad")
    if any(not item["matchesExpected"] for item in files): problems.append("source-hash-mismatch")
    if any(not item["matchesExpected"] for item in assets): problems.append("asset-hash-mismatch")
    if any(not item["free"] for item in ports.values()): problems.append("test-port-in-use")
    return {"runId": spec["runId"], "root": str(root), "container": str(container),
            "rootAlreadyExists": root.exists(), "python": {"path": str(python), "actual": version,
            "expected": expected, "matches": version == expected}, "ports": ports,
            "files": files, "readOnlyAssets": assets, "problems": problems, "writes": False,
            "registersLaunchAgent": False, "result": "READY_TO_STAGE" if not problems else "BLOCKED"}


def _expanded(value: str, root: Path, python: Path, ports: dict[str, int]) -> str:
    return value.replace("{root}", str(root)).replace("{python}", str(python)) \
        .replace("{port:engine}", str(ports["engine"])).replace("{port:adapter}", str(ports["adapter"]))


def stage(spec_path: Path, **options: Any) -> dict[str, Any]:
    spec, root, container = read_spec(spec_path, **options)
    plan_result = plan(spec_path, **options)
    if plan_result["problems"]:
        raise RuntimeErrorSafe("Runtime plan 未通过：" + ", ".join(plan_result["problems"]))
    if root.exists() or root.is_symlink():
        raise RuntimeErrorSafe("Runtime root 已存在；stage 不会覆盖或合并旧目录")
    if container.is_symlink() or (container.exists() and not container.is_dir()):
        raise RuntimeErrorSafe("runId 隔离目录必须是普通目录")
    if not container.exists():
        container.mkdir(mode=0o700, parents=True)
    reject_symlink_components(container)
    if stat.S_IMODE(container.stat().st_mode) & 0o077:
        raise RuntimeErrorSafe("runId 隔离目录权限必须限制为当前用户")
    actual_python = python_version(Path(spec["python"]["executable"]))
    if spec["python"]["version"] != actual_python:
        raise RuntimeErrorSafe("Python 版本与 Runtime 计划不符")
    for port in spec["ports"].values():
        if not port_free(port):
            raise RuntimeErrorSafe(f"测试端口 {port} 已被占用")
    root.mkdir(mode=0o700)
    reject_symlink_components(root)
    staged: list[dict[str, Any]] = []
    try:
        for entry in spec["files"]:
            source = Path(entry["source"])
            digest = sha256_file(source)
            if entry.get("sha256") and entry["sha256"] != digest:
                raise RuntimeErrorSafe(f"来源哈希变化：{Path(entry['target']).name}")
            relative = safe_relative(entry["target"], "target")
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            reject_symlink_components(target.parent)
            if target.exists() or target.is_symlink():
                raise RuntimeErrorSafe(f"stage 目标已存在：{relative.as_posix()}")
            shutil.copyfile(source, target, follow_symlinks=False)
            os.chmod(target, 0o600)
            if sha256_file(target) != digest:
                raise RuntimeErrorSafe(f"stage 后哈希不匹配：{relative.as_posix()}")
            staged.append({"path": relative.as_posix(), "source": str(source), "bytes": target.stat().st_size,
                           "sha256": digest, "mode": "0600"})
        asset_records = []
        for asset in spec.get("readOnlyAssets", []):
            path = Path(asset["path"])
            digest = sha256_file(path)
            if asset.get("sha256") and asset["sha256"] != digest:
                raise RuntimeErrorSafe(f"只读资产哈希变化：{path.name}")
            asset_stat = path.lstat()
            asset_records.append({"path": str(path), "bytes": asset_stat.st_size,
                                  "sha256": digest, "mode": stat.S_IMODE(asset_stat.st_mode),
                                  "linkCount": asset_stat.st_nlink, "access": "read-only"})
        record = {"schemaVersion": 1, "runId": spec["runId"], "root": str(root),
                  "createdAt": datetime.now(timezone.utc).isoformat(), "state": "staged",
                  "ports": spec["ports"], "python": {"executable": spec["python"]["executable"],
                  "version": actual_python}, "files": staged, "readOnlyAssets": asset_records,
                  "processes": spec["processes"], "specSha256": sha256_file(spec_path)}
        record["executionPlanSha256"] = _execution_digest(record)
        manifest_path = root / RUNTIME_MANIFEST
        _write_json_private(manifest_path, record)
        return {"runId": spec["runId"], "root": str(root), "stagedFiles": len(staged),
                "readOnlyAssets": len(asset_records), "launchAgentsRegistered": False, "result": "STAGED"}
    except Exception:
        for entry in reversed(staged):
            target = root / entry["path"]
            try:
                reject_symlink_components(target)
                target_stat = target.lstat()
            except (RuntimeErrorSafe, OSError):
                continue
            if stat.S_ISREG(target_stat.st_mode) and sha256_file(target) == entry["sha256"]:
                target.unlink()
        for current, directories, _ in os.walk(root, topdown=False):
            for directory in directories:
                candidate = Path(current) / directory
                try: candidate.rmdir()
                except OSError: pass
        try: root.rmdir()
        except OSError: pass
        raise


def _load_manifest(root: Path) -> dict[str, Any]:
    path = root / RUNTIME_MANIFEST
    try:
        reject_symlink_components(path)
    except RuntimeErrorSafe as error:
        raise RuntimeErrorSafe("Runtime manifest 路径含符号链接") from error
    if path.is_symlink() or not path.is_file():
        raise RuntimeErrorSafe("Runtime manifest 不能是符号链接")
    try: manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error: raise RuntimeErrorSafe("Runtime manifest 不存在或损坏") from error
    return manifest


def _execution_digest(manifest: dict[str, Any]) -> str:
    fields = {name: manifest[name] for name in ("runId", "root", "ports", "python", "files", "readOnlyAssets", "processes")}
    canonical = json.dumps(fields, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _validate_manifest(manifest: Any, root: Path, run_id: str, container: Path) -> dict[str, Any]:
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1:
        raise RuntimeErrorSafe("Runtime manifest 版本或结构无效")
    if manifest.get("root") != str(root) or manifest.get("runId") != run_id:
        raise RuntimeErrorSafe("Runtime manifest 身份不匹配")
    if manifest.get("state") not in {"staged", "running", "stopped", "failed", "rolled-back"}:
        raise RuntimeErrorSafe("Runtime manifest 状态无效")
    reject_secret_keys(manifest, "manifest")

    ports = manifest.get("ports")
    if not isinstance(ports, dict) or set(ports) != {"engine", "adapter"}:
        raise RuntimeErrorSafe("Runtime manifest ports 无效")
    values = list(ports.values())
    if (any(type(port) is not int or not PORT_MIN <= port <= PORT_MAX for port in values)
            or len(set(values)) != 2):
        raise RuntimeErrorSafe("Runtime manifest 含非专用或重复端口")

    python = manifest.get("python")
    if not isinstance(python, dict) or not isinstance(python.get("executable"), str):
        raise RuntimeErrorSafe("Runtime manifest Python 记录无效")
    executable = Path(python["executable"])
    if not executable.is_absolute() or not re.fullmatch(r"\d+\.\d+\.\d+", str(python.get("version", ""))):
        raise RuntimeErrorSafe("Runtime manifest Python 版本记录无效")
    if is_within(executable, Path(os.path.abspath(Path.home() / "Library/Application Support/Coopanion"))):
        raise RuntimeErrorSafe("Runtime manifest Python 指向正式 Coopanion 支持目录")
    try:
        reject_symlink_components(executable)
        executable_stat = executable.lstat()
        if (not stat.S_ISREG(executable_stat.st_mode) or not os.access(executable, os.X_OK)
                or executable.resolve(strict=True) != executable):
            raise RuntimeErrorSafe("Runtime manifest Python 路径已变化")
        if python_version(executable) != python["version"]:
            raise RuntimeErrorSafe("Runtime manifest Python 版本已变化")
    except OSError as error:
        raise RuntimeErrorSafe("Runtime manifest Python 不可读取") from error

    files = manifest.get("files")
    if not isinstance(files, list) or not files:
        raise RuntimeErrorSafe("Runtime manifest staged 文件清单无效")
    targets: set[str] = set()
    reserved = {RUNTIME_MANIFEST, PROCESS_STATE, "home", "tmp", "logs"}
    for entry in files:
        if not isinstance(entry, dict): raise RuntimeErrorSafe("Runtime manifest 文件项无效")
        relative = safe_relative(entry.get("path"), "manifest.files.path")
        if relative.parts[0] in reserved or relative.as_posix() in targets:
            raise RuntimeErrorSafe("Runtime manifest 文件路径重复或保留")
        if type(entry.get("bytes")) is not int or entry["bytes"] < 0:
            raise RuntimeErrorSafe("Runtime manifest 文件大小无效")
        if not isinstance(entry.get("sha256"), str) or not SHA256.fullmatch(entry["sha256"]):
            raise RuntimeErrorSafe("Runtime manifest 文件哈希无效")
        targets.add(relative.as_posix())

    assets = manifest.get("readOnlyAssets")
    if not isinstance(assets, list) or not assets:
        raise RuntimeErrorSafe("Runtime manifest 只读资产清单无效")
    for asset in assets:
        if not isinstance(asset, dict) or not isinstance(asset.get("path"), str):
            raise RuntimeErrorSafe("Runtime manifest 只读资产项无效")
        asset_path = Path(asset["path"])
        if (not asset_path.is_absolute() or not is_within(Path(os.path.abspath(asset_path)), container)
                or asset.get("access") != "read-only" or type(asset.get("mode")) is not int
                or type(asset.get("linkCount")) is not int or asset.get("linkCount") != 1):
            raise RuntimeErrorSafe("Runtime manifest 只读资产必须位于本次 run 目录")
        if type(asset.get("bytes")) is not int or asset["bytes"] < 0:
            raise RuntimeErrorSafe("Runtime manifest 资产大小无效")
        if not isinstance(asset.get("sha256"), str) or not SHA256.fullmatch(asset["sha256"]):
            raise RuntimeErrorSafe("Runtime manifest 资产哈希无效")

    processes = manifest.get("processes")
    if not isinstance(processes, list) or len(processes) != 2:
        raise RuntimeErrorSafe("Runtime manifest 进程清单无效")
    if [item.get("id") if isinstance(item, dict) else None for item in processes] != ["engine", "adapter"]:
        raise RuntimeErrorSafe("Runtime manifest 进程顺序无效")
    for process in processes:
        argv = process.get("argv")
        if not isinstance(argv, list) or len(argv) < 2 or argv[0] != "{python}":
            raise RuntimeErrorSafe("Runtime manifest 进程必须由固定 Python 解释器启动")
        if not all(isinstance(argument, str) for argument in argv):
            raise RuntimeErrorSafe("Runtime manifest 进程参数无效")
        script = argv[1]
        if not script.startswith("{root}/") or not script.endswith(".py"):
            raise RuntimeErrorSafe("Runtime manifest 进程入口必须位于本次 Runtime")
        script_target = safe_relative(script[len("{root}/"):], "manifest.process.argv[1]").as_posix()
        if script_target not in targets:
            raise RuntimeErrorSafe("Runtime manifest 进程入口未纳入哈希清单")
        production_path = str(Path.home() / "Library/Application Support/Coopanion")
        if any(argument.lower() in FORBIDDEN_COMMANDS or PRODUCTION_PORT.search(argument)
               or "cooperation.app" in argument.lower() or production_path in argument for argument in argv):
            raise RuntimeErrorSafe("Runtime manifest 进程参数包含禁止命令或生产端口")
        cwd = process.get("cwd")
        if not isinstance(cwd, str) or not cwd.startswith("{root}/"):
            raise RuntimeErrorSafe("Runtime manifest cwd 必须位于本次 Runtime")
        safe_relative(cwd[len("{root}/"):], "manifest.process.cwd")
        process["env"] = _validate_runtime_env(process.get("env", {}), root, container, ports)
        try:
            health = urllib.parse.urlsplit(str(process.get("healthUrl", "")))
            health_port = health.port
        except ValueError as error:
            raise RuntimeErrorSafe("Runtime manifest healthUrl 无效") from error
        if (health.scheme != "http" or health.hostname != "127.0.0.1" or health_port != ports[process["id"]]
                or health.username is not None or health.password is not None):
            raise RuntimeErrorSafe("Runtime manifest healthUrl 必须指向专用本机端口")
        timeout = process.get("startupTimeoutSec", 60)
        if type(timeout) is not int or not 1 <= timeout <= 300:
            raise RuntimeErrorSafe("Runtime manifest 启动超时无效")
    if not isinstance(manifest.get("specSha256"), str) or not SHA256.fullmatch(manifest["specSha256"]):
        raise RuntimeErrorSafe("Runtime manifest spec 哈希无效")
    if manifest.get("executionPlanSha256") != _execution_digest(manifest):
        raise RuntimeErrorSafe("Runtime manifest 执行计划哈希不匹配")
    return manifest


def _manifest_root(root_value: str, run_id: str | None = None, home: Path | None = None,
                   repo_root: Path | None = None, test_roots: tuple[Path, ...] | None = None) -> Path:
    if not isinstance(root_value, str) or not Path(root_value).is_absolute():
        raise RuntimeErrorSafe("root 必须是绝对路径")
    if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
        raise RuntimeErrorSafe("操作 Runtime 必须显式提供有效 runId")
    root = Path(os.path.abspath(root_value))
    _, container = allowed_runtime_root(root, run_id, home or Path.home(), repo_root or REPO_ROOT, test_roots)
    if root.is_symlink() or not root.is_dir():
        raise RuntimeErrorSafe("Runtime root 必须是普通目录")
    _validate_manifest(_load_manifest(root), root, run_id, container)
    return root


def _check_staged(root: Path, manifest: dict[str, Any]) -> list[str]:
    problems = []
    for entry in manifest.get("files", []):
        relative = safe_relative(entry.get("path"), "manifest.files.path")
        path = root / relative
        try:
            reject_symlink_components(path)
            path_stat = path.lstat()
        except (RuntimeErrorSafe, OSError):
            problems.append(f"unsafe-or-missing:{relative.as_posix()}")
        else:
            if not stat.S_ISREG(path_stat.st_mode):
                problems.append(f"missing-or-not-file:{relative.as_posix()}")
            elif path_stat.st_size != entry.get("bytes") or sha256_file(path) != entry.get("sha256"):
                problems.append(f"changed:{relative.as_posix()}")
    for asset in manifest.get("readOnlyAssets", []):
        path = Path(asset["path"])
        try:
            reject_symlink_components(path)
            asset_stat = path.lstat()
        except (RuntimeErrorSafe, OSError):
            problems.append(f"unsafe-read-only-asset:{path.name}")
        else:
            if (not stat.S_ISREG(asset_stat.st_mode) or asset_stat.st_nlink != asset.get("linkCount")
                    or stat.S_IMODE(asset_stat.st_mode) != asset.get("mode") or asset_stat.st_mode & 0o222
                    or asset_stat.st_size != asset.get("bytes") or sha256_file(path) != asset.get("sha256")):
                problems.append(f"read-only-asset-changed:{path.name}")
    return problems


def check(root_value: str, run_id: str | None = None, home: Path | None = None,
          repo_root: Path | None = None, test_roots: tuple[Path, ...] | None = None) -> dict[str, Any]:
    root = _manifest_root(root_value, run_id, home, repo_root, test_roots)
    manifest = _load_manifest(root)
    problems = _check_staged(root, manifest)
    state = None
    try:
        state = _read_process_state(root, manifest)
    except RuntimeErrorSafe:
        problems.append("process-state-invalid")
    if state is None:
        if manifest.get("state") != "staged":
            problems.append("process-state-missing")
        for name, port in manifest["ports"].items():
            if not port_free(port): problems.append(f"port-in-use:{name}:{port}")
    elif state["state"] != "running":
        problems.append(f"process-state-{state['state']}")
        for name, port in manifest["ports"].items():
            if not port_free(port): problems.append(f"port-in-use:{name}:{port}")
    else:
        process_by_id = {item.get("id"): item for item in state["processes"] if isinstance(item, dict)}
        if set(process_by_id) != {"engine", "adapter"}:
            problems.append("process-state-process-set-invalid")
        for definition in manifest["processes"]:
            name = definition["id"]
            record = process_by_id.get(name)
            if not record or not _process_matches(record):
                problems.append(f"process-not-owned:{name}")
            else:
                port = manifest["ports"][name]
                if not _loopback_listener(record["pid"], port):
                    problems.append(f"process-listener-not-loopback:{name}")
                if not _health(record.get("healthUrl", "")):
                    problems.append(f"process-unhealthy:{name}")
    return {"runId": manifest["runId"], "root": str(root), "state": manifest.get("state"),
            "problems": problems, "result": "READY" if not problems else "NOT_READY"}


def _process_snapshot(pid: int) -> tuple[int, str, str] | None:
    try:
        pgid = os.getpgid(pid)
        result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "stat=", "-o", "lstart=", "-o", "command="],
                                capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError): return None
    fields = result.stdout.strip().split()
    if result.returncode != 0 or len(fields) < 7 or fields[0].startswith("Z"):
        return None
    started_at = " ".join(fields[1:6])
    command = " ".join(fields[6:])
    return pgid, started_at, command


def _process_matches(record: dict[str, Any]) -> bool:
    try:
        pid, pgid = record["pid"], record["pgid"]
        if type(pid) is not int or type(pgid) is not int or pid <= 1 or pgid <= 1:
            return False
        snapshot = _process_snapshot(pid)
        return bool(snapshot and snapshot[0] == pgid
                    and snapshot[1] == record["processStartedAt"]
                    and record["scriptPath"] in snapshot[2])
    except (KeyError, TypeError, ValueError):
        return False


def _process_group_members(pgid: int) -> list[tuple[int, str]]:
    if type(pgid) is not int or pgid <= 1:
        return []
    try:
        result = subprocess.run(["/bin/ps", "-axo", "pid=,pgid=,stat=,command="],
                                capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError) as error:
        raise RuntimeErrorSafe("无法检查 Runtime 进程组") from error
    if result.returncode != 0:
        raise RuntimeErrorSafe("无法检查 Runtime 进程组")
    members = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 3)
        if len(fields) == 4 and fields[1].isdigit() and int(fields[1]) == pgid and not fields[2].startswith("Z"):
            members.append((int(fields[0]), fields[3]))
    return members


def _health(url: str) -> bool:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url, timeout=1) as response: return 200 <= response.status < 300
    except (OSError, urllib.error.URLError): return False


def _loopback_listener(pid: int, port: int) -> bool:
    lsof = shutil.which("lsof")
    if not lsof:
        return False
    try:
        result = subprocess.run([lsof, "-nP", "-a", "-p", str(pid), f"-iTCP:{port}",
                                 "-sTCP:LISTEN", "-Fn"], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return False
    listeners = [line[1:] for line in result.stdout.splitlines() if line.startswith("n")]
    return result.returncode == 0 and listeners == [f"127.0.0.1:{port}"]


def _read_process_state(root: Path, manifest: dict[str, Any]) -> dict[str, Any] | None:
    path = root / PROCESS_STATE
    try:
        reject_symlink_components(path)
        path_stat = path.lstat()
    except FileNotFoundError:
        return None
    except (OSError, RuntimeErrorSafe) as error:
        raise RuntimeErrorSafe("进程状态路径不可安全读取") from error
    if not stat.S_ISREG(path_stat.st_mode):
        raise RuntimeErrorSafe("进程状态必须是普通文件")
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeErrorSafe("进程状态不存在或损坏") from error
    if (not isinstance(state, dict) or state.get("schemaVersion") != 1
            or state.get("runId") != manifest["runId"]
            or state.get("state") not in {"starting", "running", "stopped", "failed"}
            or not isinstance(state.get("processes"), list) or len(state["processes"]) > 2):
        raise RuntimeErrorSafe("进程状态身份或结构无效")
    python = Path(manifest["python"]["executable"])
    expected_health = {item["id"]: _expanded(item["healthUrl"], root, python, manifest["ports"])
                       for item in manifest["processes"]}
    expected_script = {item["id"]: _expanded(item["argv"][1], root, python, manifest["ports"])
                       for item in manifest["processes"]}
    ids = set()
    for process in state["processes"]:
        if not isinstance(process, dict) or process.get("id") not in expected_health:
            raise RuntimeErrorSafe("进程状态包含未登记的进程")
        if process["id"] in ids:
            raise RuntimeErrorSafe("进程状态包含重复进程")
        ids.add(process["id"])
        if (type(process.get("pid")) is not int or process["pid"] <= 1
                or type(process.get("pgid")) is not int or process["pgid"] != process["pid"]
                or not isinstance(process.get("processStartedAt"), str) or not process["processStartedAt"]
                or process.get("scriptPath") != expected_script[process["id"]]
                or process.get("healthUrl") != expected_health[process["id"]]):
            raise RuntimeErrorSafe("进程状态记录无法核验归属")
    if state["state"] == "running" and ids != {"engine", "adapter"}:
        raise RuntimeErrorSafe("运行状态未记录完整进程集合")
    return state


def start_test(root_value: str, run_id: str | None = None, home: Path | None = None,
               repo_root: Path | None = None, test_roots: tuple[Path, ...] | None = None) -> dict[str, Any]:
    root = _manifest_root(root_value, run_id, home, repo_root, test_roots)
    manifest = _load_manifest(root)
    ready = check(str(root), run_id, home, repo_root, test_roots)
    if ready["problems"]: raise RuntimeErrorSafe("Runtime 未通过 check：" + ", ".join(ready["problems"]))
    state_path = root / PROCESS_STATE
    if state_path.is_symlink() or state_path.exists(): raise RuntimeErrorSafe("已有进程状态记录；先执行 stop-test")
    python = Path(manifest["python"]["executable"])
    if python_version(python) != manifest["python"]["version"]:
        raise RuntimeErrorSafe("Runtime Python 版本与 manifest 不符")
    isolated_home = root / "home"
    isolated_tmp = root / "tmp"
    logs = root / "logs"
    for directory in (isolated_home, isolated_tmp, logs):
        if directory.exists() or directory.is_symlink():
            raise RuntimeErrorSafe(f"Runtime 管理目录已存在，拒绝复用：{directory.name}")
        directory.mkdir(mode=0o700)
        reject_symlink_components(directory)
    started: list[dict[str, Any]] = []
    launched: list[subprocess.Popen[bytes]] = []
    state = {"schemaVersion": 1, "runId": manifest["runId"], "state": "starting", "processes": [],
             "startedAt": datetime.now(timezone.utc).isoformat()}
    try:
        _write_json_private(state_path, state)
        for item in manifest["processes"]:
            argv = [_expanded(arg, root, python, manifest["ports"]) for arg in item["argv"]]
            if not argv or Path(argv[0]) != python:
                raise RuntimeErrorSafe("进程必须由 manifest 指定的 Python 启动")
            cwd = Path(_expanded(item["cwd"], root, python, manifest["ports"]))
            try:
                reject_symlink_components(cwd)
            except RuntimeErrorSafe as error:
                raise RuntimeErrorSafe("进程 cwd 路径含符号链接") from error
            if not is_within(cwd, root) or not cwd.is_dir(): raise RuntimeErrorSafe("进程 cwd 必须是 Runtime 内已有目录")
            script = Path(argv[1])
            try:
                reject_symlink_components(script)
            except RuntimeErrorSafe as error:
                raise RuntimeErrorSafe("进程入口路径含符号链接") from error
            if not is_within(script, root) or not script.is_file():
                raise RuntimeErrorSafe("进程入口必须是本次 Runtime 的 staged 文件")
            port = manifest["ports"][item["id"]]
            if not port_free(port):
                raise RuntimeErrorSafe(f"测试端口 {port} 在启动前被占用")
            env = {key: os.environ[key] for key in ("LANG", "LC_ALL") if key in os.environ}
            env.update({key: _expanded(value, root, python, manifest["ports"]) for key, value in item.get("env", {}).items()})
            env.update({"HOME": str(isolated_home), "TMPDIR": str(isolated_tmp),
                        "PATH": str(python.parent) + os.pathsep + os.defpath, "PYTHONUNBUFFERED": "1",
                        "PYTHONNOUSERSITE": "1", "NO_PROXY": "127.0.0.1,localhost"})
            log_path = logs / f"{item['id']}.log"
            if log_path.is_symlink(): raise RuntimeErrorSafe("进程日志不能是符号链接")
            log_descriptor = os.open(log_path, os.O_CREAT | os.O_APPEND | os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(log_descriptor, "ab") as log:
                process = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                           stdout=log, stderr=subprocess.STDOUT, start_new_session=True, shell=False)
            launched.append(process)
            pgid = os.getpgid(process.pid)
            deadline = time.monotonic() + int(item.get("startupTimeoutSec", 60))
            snapshot = None
            while time.monotonic() < deadline:
                if process.poll() is not None: break
                snapshot = _process_snapshot(process.pid)
                if snapshot: break
                time.sleep(0.2)
            if process.poll() is not None or not snapshot:
                raise RuntimeErrorSafe(f"测试进程未就绪：{item['id']}；日志保留在 logs/")
            record = {"id": item["id"], "pid": process.pid, "pgid": pgid,
                      "processStartedAt": snapshot[1], "scriptPath": str(script),
                      "healthUrl": _expanded(item["healthUrl"], root, python, manifest["ports"])}
            started.append(record)
            state["processes"] = started
            _write_json_private(state_path, state)
            if not _health(record["healthUrl"]):
                while time.monotonic() < deadline and _process_matches(record) and not _health(record["healthUrl"]):
                    time.sleep(0.2)
                if not _process_matches(record) or not _health(record["healthUrl"]):
                    raise RuntimeErrorSafe(f"测试进程健康检查失败：{item['id']}；日志保留在 logs/")
            if not _loopback_listener(process.pid, port):
                raise RuntimeErrorSafe(f"测试进程监听地址不是 127.0.0.1：{item['id']}；日志保留在 logs/")
            DETACHED_HANDLES[process.pid] = process
        state["state"] = "running"
        state["startedAt"] = datetime.now(timezone.utc).isoformat()
        _write_json_private(state_path, state)
        manifest["state"] = "running"
        _write_json_private(root / RUNTIME_MANIFEST, manifest)
        return {"runId": manifest["runId"], "processes": [p["id"] for p in started], "launchAgentsRegistered": False, "result": "RUNNING"}
    except Exception as error:
        for process in launched:
            if process.poll() is not None:
                continue
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for process in launched:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
            DETACHED_HANDLES.pop(process.pid, None)
        state["state"] = "failed"
        state["failureType"] = type(error).__name__
        try:
            _write_json_private(state_path, state)
            manifest["state"] = "failed"
            _write_json_private(root / RUNTIME_MANIFEST, manifest)
        except RuntimeErrorSafe:
            pass
        raise


def stop_test(root_value: str, run_id: str | None = None, timeout_sec: int = 8, home: Path | None = None,
              repo_root: Path | None = None, test_roots: tuple[Path, ...] | None = None) -> dict[str, Any]:
    if type(timeout_sec) is not int or not 1 <= timeout_sec <= 120:
        raise RuntimeErrorSafe("stop-test 超时必须在 1–120 秒范围内")
    root = _manifest_root(root_value, run_id, home, repo_root, test_roots)
    manifest = _load_manifest(root)
    state = _read_process_state(root, manifest)
    if state is None:
        if manifest["state"] != "staged":
            raise RuntimeErrorSafe("manifest 显示 Runtime 已启动，但进程归属记录缺失")
        return {"runId": manifest["runId"], "stopped": [], "result": "ALREADY_STOPPED"}
    stopped = []
    for process in state.get("processes", []):
        if not _process_matches(process):
            if _process_snapshot(process["pid"]) is not None:
                raise RuntimeErrorSafe(f"进程身份变化，拒绝停止 PID {process['pid']}")
            if not _process_group_members(process["pgid"]):
                handle = DETACHED_HANDLES.pop(process["pid"], None)
                if handle:
                    handle.wait(timeout=3)
                stopped.append(process["id"]); continue
        try:
            os.killpg(process["pgid"], signal.SIGTERM)
        except ProcessLookupError:
            stopped.append(process["id"])
            continue
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline and _process_group_members(process["pgid"]):
            time.sleep(0.1)
        if _process_group_members(process["pgid"]):
            raise RuntimeErrorSafe(f"进程组未在 {timeout_sec} 秒内退出：{process['id']}；保留 manifest 与状态记录")
        handle = DETACHED_HANDLES.pop(process["pid"], None)
        if handle:
            handle.wait(timeout=3)
        stopped.append(process["id"])
    state["state"] = "stopped"; state["stoppedAt"] = datetime.now(timezone.utc).isoformat()
    _write_json_private(root / PROCESS_STATE, state)
    manifest["state"] = "stopped"
    _write_json_private(root / RUNTIME_MANIFEST, manifest)
    return {"runId": manifest["runId"], "stopped": stopped, "result": "STOPPED"}


def rollback(root_value: str, run_id: str | None = None, home: Path | None = None,
             repo_root: Path | None = None, test_roots: tuple[Path, ...] | None = None) -> dict[str, Any]:
    root = _manifest_root(root_value, run_id, home, repo_root, test_roots)
    manifest = _load_manifest(root)
    stop_test(str(root), run_id, home=home, repo_root=repo_root, test_roots=test_roots)
    removed, preserved = [], []
    for entry in manifest.get("files", []):
        relative = safe_relative(entry["path"], "manifest.files.path")
        path = root / relative
        try:
            reject_symlink_components(path)
            path_stat = path.lstat()
        except FileNotFoundError:
            continue
        except (OSError, RuntimeErrorSafe):
            preserved.append(relative.as_posix()); continue
        if not stat.S_ISREG(path_stat.st_mode) or sha256_file(path) != entry["sha256"]:
            preserved.append(relative.as_posix()); continue
        path.unlink(); removed.append(relative.as_posix())
    manifest["state"] = "rolled-back"
    manifest["rollback"] = {"removed": removed, "preservedChangedFiles": preserved,
                            "readOnlyAssetsDeleted": False, "completedAt": datetime.now(timezone.utc).isoformat()}
    _write_json_private(root / RUNTIME_MANIFEST, manifest)
    return {"runId": manifest["runId"], "removed": removed, "preservedChangedFiles": preserved,
            "readOnlyAssetsDeleted": False, "logsPreserved": (root / "logs").exists(),
            "result": "ROLLED_BACK" if not preserved else "ROLLED_BACK_WITH_PRESERVED_FILES"}


def main() -> int:
    parser = argparse.ArgumentParser(description="隔离 Voice Runtime 生命周期管理；不注册 LaunchAgent，不使用正式端口。")
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("plan", "stage"):
        cmd = sub.add_parser(name); cmd.add_argument("spec", type=Path)
    for name in ("check", "start-test", "stop-test", "rollback"):
        cmd = sub.add_parser(name); cmd.add_argument("root"); cmd.add_argument("--run-id", required=True)
    args = parser.parse_args()
    try:
        if args.action == "plan": result = plan(args.spec)
        elif args.action == "stage": result = stage(args.spec)
        elif args.action == "check": result = check(args.root, args.run_id)
        elif args.action == "start-test": result = start_test(args.root, args.run_id)
        elif args.action == "stop-test": result = stop_test(args.root, args.run_id)
        else: result = rollback(args.root, args.run_id)
    except RuntimeErrorSafe as error:
        print(json.dumps({"result": "BLOCKED", "reason": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("result", "").startswith(("READY", "STAGED", "RUNNING", "STOPPED", "ALREADY_STOPPED", "ROLLED_BACK")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
