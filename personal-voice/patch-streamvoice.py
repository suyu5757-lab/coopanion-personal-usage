#!/usr/bin/env python3
"""把 GPT-SoVITS 朗读链路装进 streamvoice 0.4.0：核对上游指纹、可恢复应用、可回滚。

补丁改的是扩展目录里的文件，不是本仓库源码。脚本先核对每个上游文件的 sha256，
再把结果写进同文件系统的暂存目录、校验 hash，最后逐项原子替换。事务记录在第一次替换前
持久化；捕获到错误时立即恢复，进程中断后下次显式应用会先恢复再重新应用。每次事务都
保留旧、新 hash 与备份位置，`--rollback` 可手动回退。

状态，`--check` 只报告、不改文件：

  missing       没找到扩展源码目录
  incompatible  上游文件既不是 0.4.0 原版、也不是本补丁的产物（扩展升级或手改过）
  clean         当前是 0.4.0 原版，可以应用
  patch         补丁只应用了一部分，或存在待恢复事务
  patched       补丁已完整应用

`--check` 和 `--json` 都只读。退出码：0 = patched；1 = clean 或 patch（还需要动手）；2 = 其它。
"""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUPPORT = Path(os.environ.get("COOPANION_SUPPORT", Path.home() / "Library/Application Support/Coopanion"))
DEFAULT_SRC = SUPPORT / "extensions/node_modules/cortico-world-streamvoice/src"
DEFAULT_MANIFEST = HERE / "patch-manifest.json"

EXIT = {"patched": 0, "clean": 1, "patch": 1, "missing": 2, "incompatible": 2}


class PatchError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_text(path):
    return Path(path).read_bytes().decode("utf-8")


def splice(text, start, end, new):
    """把 start 到 end 之间（含两端）换成 new；锚点必须各自唯一。"""
    if text.count(start) != 1 or text.count(end) != 1:
        raise PatchError("streamvoice 源码与 0.4.0 不符：锚点不唯一，未改动任何文件")
    head = text.index(start)
    tail = text.index(end, head) + len(end)
    return text[:head] + new + text[tail:]


# ---------------------------------------------------------------------------
# world.ts 的改动：句段规划带位置、每段自己的关联值与情绪、播放器由世界注入
# ---------------------------------------------------------------------------

WORLD_SPLICES = [
    (
        "import { JsonStringField } from './args.ts';",
        "import { MarkerFilter, speakable } from './clean.ts';",
        """import { JsonStringField } from './args.ts';
import { speakable } from './clean.ts';
import { createPlayer } from './player.ts';
import { SpeechPlanner } from './speech-plan.ts';
import type { PlannedSegment, SpeechTraceV1 } from './speech-plan.ts';""",
    ),
    (
        '  item?: { type?: string; name?: string; arguments?: string } | null;',
        '  item?: { type?: string; name?: string; arguments?: string } | null;',
        """  item?: { id?: string; type?: string; name?: string; arguments?: string } | null;""",
    ),
    (
        'interface CallStream {',
        '  startedAt: number;\n}',
        """interface CallStream {
  index: number;
  kind: 'say' | 'ask';
  tool: string;
  field: JsonStringField;
  planner: SpeechPlanner;
  /** 这批回复的关联值；每来一轮新回复换一个。 */
  batchId: string;
  /** 这条工具调用的关联值；优先用框架给的 item id。 */
  callId: string;
  /** 批次加调用拼成的键；句段记录用它串起同一句的显示与播放。 */
  utteranceId: string;
  /** 这一条调用切出了几块。 */
  chunks: number;
  /** 第一条增量到达的时刻。 */
  startedAt: number;
}""",
    ),
    (
        '  /** 这一轮台词从什么时候开始写；日志里的「开写后 N ms」用它。 */',
        '  private batchStart = 0;',
        """  /** 这一轮台词从什么时候开始写；日志里的「开写后 N ms」用它。 */
  private batchStart = 0;
  /** 这一批回复的关联值；每来一轮新回复换一个。 */
  private batchId = 'b0';
  private batchSeq = 0;""",
    ),
    (
        'export interface StreamVoiceWorldOptions {',
        '  persist: (patch: Record<string, unknown>) => void;\n}',
        """export interface StreamVoiceWorldOptions {
  /** 活的 `worlds.streamvoice` 段：嗓音、念选项、切块长度都在里面。 */
  cfg: StreamVoiceConfigSection;
  /** 部署目录；只用来看看是不是还有别人也在朗读。 */
  botDir: string;
  /** 把改动深合并进 `worlds.streamvoice` 并落盘；模型改嗓音时用。 */
  persist: (patch: Record<string, unknown>) => void;
  /** 换一个朗读器；不给就自己建一个。 */
  speaker?: Speaker;
}""",
    ),
    (
        '    this.speaker = new Speaker((line) => this.log(line));',
        '    this.speaker = new Speaker((line) => this.log(line));',
        """    this.speaker = this.opts.speaker ?? new Speaker((line) => this.log(line), createPlayer((line) => this.log(line)));""",
    ),
    (
        '        if (name === SAY_TOOL) {',
        "        if (name === ASK_TOOL && readAskOf(this.opts.cfg)) this.open(ev.output_index ?? 0, 'ask', name);",
        """        if (name === SAY_TOOL) {
          if (readSayOf(this.opts.cfg)) this.open(ev.output_index ?? 0, 'say', name, item.id);
          return;
        }
        if (name === ASK_TOOL && readAskOf(this.opts.cfg)) this.open(ev.output_index ?? 0, 'ask', name, item.id);""",
    ),
    (
        "      case 'response.created':",
        '        if (!this.batchStart) this.batchStart = Date.now();',
        """      case 'response.created':
        this.batchSeq++;
        this.batchId = `b${this.batchSeq}`;
        if (!this.batchStart) this.batchStart = Date.now();""",
    ),
    (
        "  private open(index: number, kind: 'say' | 'ask', tool: string): void {",
        '    this.log(`${tool} 开始生成（第 ${index} 条调用）`);\n  }',
        """  private open(index: number, kind: 'say' | 'ask', tool: string, callId?: string): void {
    if (!this.batchStart) this.batchStart = Date.now();
    // 顺手问一次 adapter 认得哪些声音标记；没拿到就按旧行为把所有标记都当情绪
    this.speaker.refreshCapability();
    const id = callId || `out-${index}`;
    this.streams.set(index, {
      index,
      kind,
      tool,
      field: new JsonStringField(kind === 'ask' ? 'question' : 'script'),
      planner: new SpeechPlanner(this.limits, () => this.speaker.capability()),
      batchId: this.batchId,
      callId: id,
      utteranceId: `${this.batchId}:${id}`,
      chunks: 0,
      startedAt: Date.now(),
    });
    this.log(`${tool} 开始生成（第 ${index} 条调用）`);
  }""",
    ),
    (
        '  /** 增量清过标记、切过句，整块交给播放队列。 */',
        '    this.speaker.say(said, this.style);\n  }',
        """  /** 增量清过标记、切过句，每一段带着自己的情绪交给播放队列。 */
  private feed(stream: CallStream, text: string): void {
    for (const segment of stream.planner.push(text)) this.speak(stream, segment);
  }

  /** 一条调用写完了：把尾巴上不够长的字也说完。 */
  private finish(stream: CallStream, rawArgs?: string): void {
    this.streams.delete(stream.index);
    for (const segment of stream.planner.flush()) this.speak(stream, segment);
    if (stream.kind === 'ask' && readOptionsOf(this.opts.cfg)) {
      const options = optionsOf(rawArgs);
      if (options.length) this.speak(stream, { text: `可选：${options.join('；')}`, start: 0, end: 0 });
    }
    const ms = Date.now() - stream.startedAt;
    this.log(`${stream.tool} 写完（${ms}ms，共 ${stream.chunks} 块）`);
  }

  /** 一轮结束还没收尾的调用，补一次收尾。 */
  private finishAll(): void {
    for (const stream of [...this.streams.values()]) this.finish(stream);
  }

  private speak(stream: CallStream, segment: PlannedSegment): void {
    const said = speakable(segment.text);
    if (!said) return;
    stream.chunks++;
    const ms = this.batchStart ? Date.now() - this.batchStart : 0;
    if (stream.chunks === 1) this.log(`切出第 1 块（${said.length} 字，开写后 ${ms}ms）：${brief(said)}`);
    else if (verboseOf(this.opts.cfg)) this.log(`切出第 ${stream.chunks} 块（${said.length} 字，开写后 ${ms}ms）`);
    // 嗓音、停顿这些是活配置，每块开口前重读一遍
    this.syncSpeaker();
    const marker = segment.marker;
    const style = marker ? { ...this.style, emotion: marker } : this.style;
    // 每一段带着自己的来源位置和关联值：不再读过滤器的「最后一个情绪」
    const trace: SpeechTraceV1 = {
      traceVersion: 1,
      batchId: stream.batchId,
      callId: stream.callId,
      utteranceId: stream.utteranceId,
      segmentId: `${stream.utteranceId}#${stream.chunks}`,
      epoch: 0,
      index: stream.chunks,
      sourceRange: { start: segment.start, end: segment.end },
      displayText: segment.text,
      spokenText: said,
      requestedReference: marker,
      displayStatus: 'unknown',
      playbackStatus: 'queued',
    };
    if (!this.speaker.say(said, style, trace)) this.log(`第 ${stream.chunks} 块只有文字、没有声音`);
  }""",
    ),
]

def world_patched(text):
    for start, end, new in WORLD_SPLICES:
        text = splice(text, start, end, new)
    return text


def world_is_patched(text):
    return all(new in text for _, _, new in WORLD_SPLICES)


def load_manifest(path):
    try:
        manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as error:
        raise PatchError(f"读不到清单 {path}：{error}")
    for key in ("upstream", "written"):
        if not manifest.get(key):
            raise PatchError(f"清单 {path} 缺少 {key}")
    if "world.ts" not in manifest["upstream"]:
        raise PatchError(f"清单 {path} 没有登记 world.ts")
    for name in manifest.get("spliced") or []:
        if not (manifest.get("results") or {}).get(name):
            raise PatchError(f"清单 {path} 没有登记 {name} 的补丁产物指纹")
    return manifest


def templates(template_dir, manifest):
    out = {}
    for name, template in manifest["written"].items():
        path = Path(template_dir) / template
        if not path.is_file():
            raise PatchError(f"缺少模板 {path}")
        out[name] = read_text(path)
    return out


def inspect(src, manifest, template_dir):
    """当前每个文件是什么状态，以及要写进去的内容。"""
    src = Path(src)
    if not src.is_dir():
        raise PatchError(f"没找到扩展源码目录：{src}")
    tpl = templates(template_dir, manifest)
    written = set(manifest["written"])
    spliced = set(manifest.get("spliced") or [])
    expected = manifest.get("results") or {}
    facts = {}
    for name, pinned in manifest["upstream"].items():
        path = src / name
        if not path.is_file():
            facts[name] = "absent"
            continue
        current = digest(path.read_bytes())
        if current == pinned:
            facts[name] = "upstream"
        elif name in tpl and read_text(path) == tpl[name]:
            facts[name] = "patched"
        elif name in spliced and current == expected.get(name):
            facts[name] = "patched"
        else:
            facts[name] = "other"
    for name, template in tpl.items():
        if name in facts:
            continue
        path = src / name
        facts[name] = "absent" if not path.is_file() else ("patched" if read_text(path) == template else "other")

    if any(state == "other" for state in facts.values()) \
            or any(state == "absent" for name, state in facts.items() if name in manifest["upstream"]):
        # 上游文件缺一个、或内容既不是原版也不是补丁产物：不能猜
        status = "incompatible"
    elif all(facts[name] == "patched" for name in written | spliced) \
            and all(state == "upstream" for name, state in facts.items() if name not in written | spliced):
        status = "patched"
    elif all(state in ("upstream", "absent") for state in facts.values()):
        status = "clean"
    else:
        status = "patch"

    targets = {}
    if status in ("clean", "patch"):
        if facts["world.ts"] == "upstream":
            patched = world_patched(read_text(src / "world.ts"))
            wanted = expected.get("world.ts")
            if digest(patched.encode("utf-8")) != wanted:
                raise PatchError("模板与清单里的补丁产物指纹不一致：先运行 --fingerprint 更新清单")
            targets["world.ts"] = patched
        for name, text in tpl.items():
            if facts.get(name) != "patched":
                targets[name] = text
    return {"status": status, "facts": facts, "targets": targets, "src": src}


def report(result, as_json, transactions=()):
    payload = {
        "status": result["status"],
        "extension": str(result["src"]),
        "files": result["facts"],
        "transactionsPending": [Path(path).name for path in transactions],
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return EXIT.get(result["status"], 2)
    print(f"status: {result['status']}")
    print(f"source: {payload['extension']}")
    print("files: " + ", ".join(f"{name}={state}" for name, state in result["facts"].items()))
    if transactions:
        print("transaction: recovery required (" + ", ".join(payload["transactionsPending"]) + ")")
    if result["status"] == "clean":
        print("0.4.0 原版；运行不带 --check 的同一命令应用补丁。")
    elif result["status"] == "patched":
        print("补丁已完整应用。")
    elif result["status"] == "incompatible":
        print("上游文件与 0.4.0 不一致：先确认新版本，再更新清单与补丁，别直接覆盖。")
    return EXIT.get(result["status"], 2)


def write_json(path, data):
    """Durably replace a transaction record without exposing a partial JSON file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        sync_directory(path.parent)
    finally:
        if temp.exists():
            temp.unlink()


def copy_backup(source, backup, staging):
    """Copy and sync a backup before publishing it beside the source file."""
    source = Path(source)
    backup = Path(backup)
    temp = Path(staging) / f"{backup.name}.pending"
    with source.open("rb") as original, temp.open("xb") as copied:
        shutil.copyfileobj(original, copied)
        copied.flush()
        shutil.copystat(source, temp)
        os.fsync(copied.fileno())
    os.replace(temp, backup)
    sync_directory(backup.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def paused(support):
    """最近一次事务是手动回退：doctor 别再自动打回去。"""
    records = transaction_records(support)
    if not records:
        return False
    try:
        return json.loads(records[-1].read_text(encoding="utf-8")).get("state") in (
            "rollback-pending", "rolled-back",
        )
    except (OSError, ValueError):
        return False


def transaction_dir(support):
    path = Path(support) / "patch-transactions"
    path.mkdir(parents=True, exist_ok=True)
    return path


def transaction_records(support):
    path = Path(support) / "patch-transactions"
    return sorted(path.glob("*.json")) if path.is_dir() else []


@contextmanager
def patch_lock(support):
    """Serialize apply/recovery/rollback while leaving --check strictly read-only."""
    lock_path = transaction_dir(support) / ".lock"
    with lock_path.open("a+b") as stream:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def transaction_state(record_path):
    try:
        return json.loads(Path(record_path).read_text(encoding="utf-8")).get("state")
    except (OSError, ValueError):
        return None


def active_transactions(support):
    active = {"preparing", "pending", "recovery-pending", "rollback-pending"}
    return [path for path in transaction_records(support) if transaction_state(path) in active]


def remove_staging(record):
    raw = record.get("staging")
    if not raw:
        return
    path = Path(raw)
    src = Path(record["source"])
    if path.parent != src.parent or not path.name.startswith(".coopanion-patch-"):
        raise PatchError(f"事务暂存路径不安全：{path}")
    if path.exists():
        shutil.rmtree(path)
        sync_directory(path.parent)


def restore_transaction(record_path, final_state):
    record = json.loads(Path(record_path).read_text(encoding="utf-8"))
    src = Path(record["source"])
    entries = record["files"]

    if record.get("phase") == "preparing":
        # No source file is replaced before the journal reaches pending.
        for entry in entries:
            path = src / entry["file"]
            current = digest(path.read_bytes()) if path.is_file() else None
            if current != entry["old"]:
                raise PatchError(f"{entry['file']} 在准备阶段被外部改过，拒绝清理事务")
        record["state"] = "rollback-pending" if final_state == "rolled-back" else "recovery-pending"
        write_json(record_path, record)
        for entry in entries:
            if entry["backup"]:
                backup = src / entry["backup"]
                if backup.exists():
                    backup.unlink()
                    sync_directory(src)
        remove_staging(record)
        record["state"] = final_state
        record.pop("phase", None)
        write_json(record_path, record)
        return

    # Check the whole target set before restoring any file.
    for entry in entries:
        path = src / entry["file"]
        current = digest(path.read_bytes()) if path.is_file() else None
        if entry["old"] is None:
            if current not in (None, entry["new"]):
                raise PatchError(f"{entry['file']} 在事务后被改过，拒绝恢复")
            continue
        if current == entry["old"]:
            continue
        if current != entry["new"]:
            raise PatchError(f"{entry['file']} 在事务后被改过，拒绝恢复")
        backup = src / entry["backup"]
        if not backup.is_file() or digest(backup.read_bytes()) != entry["old"]:
            raise PatchError(f"备份内容与记录的旧 hash 不符：{backup}")

    record["state"] = "rollback-pending" if final_state == "rolled-back" else "recovery-pending"
    write_json(record_path, record)
    for entry in reversed(entries):
        path = src / entry["file"]
        current = digest(path.read_bytes()) if path.is_file() else None
        if entry["old"] is None:
            if current == entry["new"]:
                path.unlink()
                sync_directory(src)
            continue
        if current == entry["new"]:
            os.replace(src / entry["backup"], path)
            sync_directory(src)
        else:
            backup = src / entry["backup"]
            if backup.exists():
                if digest(backup.read_bytes()) != entry["old"]:
                    raise PatchError(f"备份内容与记录的旧 hash 不符：{backup}")
                backup.unlink()
                sync_directory(src)

    remove_staging(record)
    record["state"] = final_state
    record.pop("phase", None)
    write_json(record_path, record)


def recover_pending(support):
    for record_path in transaction_records(support):
        state = transaction_state(record_path)
        if state in ("preparing", "pending", "recovery-pending"):
            restore_transaction(record_path, "recovered")
            print(f"recovered interrupted patch transaction {record_path.name}")
        elif state == "rollback-pending":
            restore_transaction(record_path, "rolled-back")
            print(f"completed interrupted manual rollback {record_path.name}")


def apply(result, manifest, support):
    src = result["src"]
    targets = result["targets"]
    if not targets:
        print("补丁已经是最新的，没有改动文件。")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + str(time.time_ns())
    staging = src.parent / f".coopanion-patch-{stamp}"
    entries = []
    for name, text in targets.items():
        path = src / name
        exists = path.is_file()
        entries.append({
            "file": name,
            "old": digest(path.read_bytes()) if exists else None,
            "new": digest(text.encode("utf-8")),
            "backup": f"{name}.bak-{stamp}" if exists else None,
        })
    record = {
        "stamp": stamp,
        "state": "preparing",
        "phase": "preparing",
        "package": manifest["package"],
        "version": manifest["version"],
        "source": str(src),
        "staging": str(staging),
        "files": entries,
    }
    record_path = transaction_dir(support) / f"{stamp}.json"
    try:
        # Journal the intended paths before creating any staging or backup files.
        write_json(record_path, record)
        staging.mkdir()
        # 1. 全部结果先写进暂存目录并逐个核对
        for name, text in targets.items():
            staged = staging / name
            with staged.open("wb") as stream:
                stream.write(text.encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            if digest((staging / name).read_bytes()) != digest(text.encode("utf-8")):
                raise PatchError(f"暂存校验失败：{name}")
        sync_directory(staging)
        # 2. 备份将被替换的原文件，并验证每份备份。
        for entry in entries:
            if entry["old"] is None:
                continue
            path = src / entry["file"]
            backup = src / entry["backup"]
            copy_backup(path, backup, staging)
            if digest(backup.read_bytes()) != entry["old"]:
                raise PatchError(f"备份校验失败：{backup}")
        sync_directory(src)
        # 3. 在第一次替换前持久化完整事务记录；下次应用可恢复被中断的事务。
        record["state"] = "pending"
        record["phase"] = "replacing"
        write_json(record_path, record)
        # 4. 逐项原子替换
        for name in targets:
            os.replace(staging / name, src / name)
            sync_directory(src)
        for name in targets:
            if digest((src / name).read_bytes()) != digest(targets[name].encode("utf-8")):
                raise PatchError(f"替换后校验失败：{name}")
        remove_staging(record)
        record["state"] = "applied"
        record.pop("phase", None)
        write_json(record_path, record)
    except Exception as error:
        if record_path.is_file():
            try:
                restore_transaction(record_path, "recovered")
            except Exception as recovery_error:
                raise PatchError(f"应用失败，事务保留待恢复：{recovery_error}") from error
        else:
            shutil.rmtree(staging, ignore_errors=True)
        raise

    for entry in entries:
        print(f"patched {entry['file']}  {entry['old'] or '-':<8} -> {entry['new']}")
        print(f"backup  {entry['backup'] or '（新增文件）'}")
    print(f"transaction {record_path}")
    print("重启 Coopanion 才会加载改动过的扩展文件。")
    return 0


def rollback(record_path):
    record = json.loads(Path(record_path).read_text(encoding="utf-8"))
    restore_transaction(record_path, "rolled-back")
    print(f"rolled back {record['stamp']}（{len(record['files'])} 个文件）")
    print("自动修复已暂停：重跑补丁或删掉这条事务记录才会恢复。")
    return 0


def latest_record(support):
    records = transaction_records(support)
    if not records:
        raise PatchError(f"没有可回退的事务：{Path(support) / 'patch-transactions'}")
    return records[-1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--extension-dir", type=Path, default=DEFAULT_SRC, help="streamvoice 的 src 目录")
    parser.add_argument("--support-dir", type=Path, default=SUPPORT, help="事务清单与备份记录的根目录")
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST, help="上游指纹清单")
    parser.add_argument("--templates", type=Path, default=HERE, help="模板目录")
    parser.add_argument("--check", action="store_true", help="只报告状态，不改文件")
    parser.add_argument("--json", action="store_true", help="用 JSON 输出状态")
    parser.add_argument("--rollback", nargs="?", const="latest", default=None, help="回退到某个事务（默认最近一次）")
    parser.add_argument("--paused", action="store_true", help="最近一次事务是手动回退时退出 0")
    parser.add_argument("--fingerprint", type=Path, default=None, help="打印某个 0.4.0 src 目录打补丁后的指纹")
    args = parser.parse_args(argv)
    if args.rollback is not None and (args.check or args.json or args.paused or args.fingerprint is not None):
        parser.error("--rollback 不能和只读查询参数组合")

    try:
        if args.paused:
            return 0 if paused(args.support_dir) else 1
        if args.fingerprint is not None:
            patched = world_patched(read_text(Path(args.fingerprint) / "world.ts"))
            print(json.dumps({"world.ts": digest(patched.encode("utf-8"))}))
            return 0
        manifest = load_manifest(args.manifest)
        if args.rollback is not None:
            with patch_lock(args.support_dir):
                path = latest_record(args.support_dir) if args.rollback == "latest" else Path(args.rollback)
                return rollback(path)
        result = inspect(args.extension_dir, manifest, args.templates)
        transactions = active_transactions(args.support_dir)
        if transactions and result["status"] != "incompatible":
            result["status"] = "patch"
        if args.check or args.json:
            return report(result, args.json, transactions)
        with patch_lock(args.support_dir):
            recover_pending(args.support_dir)
            result = inspect(args.extension_dir, manifest, args.templates)
            if result["status"] in ("missing", "incompatible"):
                return EXIT[result["status"]]
            return apply(result, manifest, args.support_dir)
    except PatchError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    except OSError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
