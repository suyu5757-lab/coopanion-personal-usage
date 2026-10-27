#!/usr/bin/env python3
"""把 GPT-SoVITS 朗读链路装进 streamvoice 0.4.0：核对上游指纹、事务替换、可回滚。

补丁改的是安装目录里的扩展源码，不是本仓库的文件。脚本先核对每个上游文件的 sha256，
再把结果写进同文件系统的暂存目录、校验 hash，最后逐项原子替换；任何一步失败，已替换的
文件全部还原。每次成功应用都在支持目录留一份事务清单，`--rollback` 用它回退。

状态，`--check` 只报告、不改文件：

  missing       没找到扩展源码目录
  incompatible  上游文件既不是 0.4.0 原版、也不是本补丁的产物（扩展升级或手改过）
  clean         当前是 0.4.0 原版，可以应用
  patch         补丁只应用了一部分
  patched       补丁已完整应用

退出码：0 = patched；1 = clean 或 patch（还需要动手）；2 = 其它。
"""

import argparse
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


def report(result, as_json):
    payload = {
        "status": result["status"],
        "extension": str(result["src"]),
        "files": result["facts"],
    }
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return EXIT.get(result["status"], 2)
    print(f"status: {result['status']}")
    print(f"source: {payload['extension']}")
    print("files: " + ", ".join(f"{name}={state}" for name, state in result["facts"].items()))
    if result["status"] == "clean":
        print("0.4.0 原版；运行不带 --check 的同一命令应用补丁。")
    elif result["status"] == "patched":
        print("补丁已完整应用。")
    elif result["status"] == "incompatible":
        print("上游文件与 0.4.0 不一致：先确认新版本，再更新清单与补丁，别直接覆盖。")
    return EXIT.get(result["status"], 2)


def write_json(path, data):
    """先写同目录临时文件再替换：写到一半失败也不会把上一条清单截断。"""
    path = Path(path)
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


def paused(support):
    """最近一次事务是手动回退：doctor 别再自动打回去。"""
    records = sorted((Path(support) / "patch-transactions").glob("*.json"))
    if not records:
        return False
    try:
        return json.loads(records[-1].read_text(encoding="utf-8")).get("state") == "rolled-back"
    except (OSError, ValueError):
        return False


def transaction_dir(support):
    path = Path(support) / "patch-transactions"
    path.mkdir(parents=True, exist_ok=True)
    return path


def apply(result, manifest, support):
    src = result["src"]
    targets = result["targets"]
    if not targets:
        print("补丁已经是最新的，没有改动文件。")
        return 0

    stamp = time.strftime("%Y%m%d-%H%M%S") + "-" + str(time.time_ns())
    staging = Path(tempfile.mkdtemp(prefix=".coopanion-patch-", dir=str(src.parent)))
    entries = []
    try:
        # 1. 全部结果先写进暂存目录并逐个核对
        for name, text in targets.items():
            (staging / name).write_bytes(text.encode("utf-8"))
            if digest((staging / name).read_bytes()) != digest(text.encode("utf-8")):
                raise PatchError(f"暂存校验失败：{name}")
        # 2. 备份将被替换的原文件
        for name in targets:
            path = src / name
            if not path.exists():
                entries.append({"file": name, "old": None, "new": digest(targets[name].encode("utf-8")), "backup": None})
                continue
            backup = path.with_name(path.name + ".bak-" + stamp)
            shutil.copy2(path, backup)
            entries.append({
                "file": name,
                "old": digest(path.read_bytes()),
                "new": digest(targets[name].encode("utf-8")),
                "backup": backup.name,
            })
        # 3. 先把事务写成 pending：中途断电也能照清单回退
        record = {
            "stamp": stamp,
            "state": "pending",
            "package": manifest["package"],
            "version": manifest["version"],
            "source": str(src),
            "files": entries,
        }
        record_path = transaction_dir(support) / f"{stamp}.json"
        write_json(record_path, record)
        # 4. 逐项原子替换
        for name in targets:
            os.replace(staging / name, src / name)
        for name in targets:
            if digest((src / name).read_bytes()) != digest(targets[name].encode("utf-8")):
                raise PatchError(f"替换后校验失败：{name}")
    except Exception:
        # 全部还原：先撤新增文件，再把备份放回原处
        for entry in reversed(entries):
            path = src / entry["file"]
            if entry["old"] is None:
                if path.exists():
                    path.unlink()
                continue
            backup = src / entry["backup"]
            if backup.exists():
                os.replace(backup, path)
        shutil.rmtree(staging, ignore_errors=True)
        raise

    shutil.rmtree(staging, ignore_errors=True)
    record["state"] = "applied"
    write_json(record_path, record)
    for entry in entries:
        print(f"patched {entry['file']}  {entry['old'] or '-':<8} -> {entry['new']}")
        print(f"backup  {entry['backup'] or '（新增文件）'}")
    print(f"transaction {record_path}")
    print("重启 Coopanion 才会加载改动过的扩展文件。")
    return 0


def rollback(record_path):
    record = json.loads(Path(record_path).read_text(encoding="utf-8"))
    src = Path(record["source"])
    entries = record["files"]
    # 只动还停在这次事务写了的那份的文件；别的状态一律拒绝
    for entry in entries:
        path = src / entry["file"]
        current = digest(path.read_bytes()) if path.is_file() else None
        if entry["old"] is None:
            if current is not None and current != entry["new"]:
                raise PatchError(f"{entry['file']} 在打完补丁后被改过，拒绝回退")
            continue
        if current == entry["old"]:
            continue
        if current != entry["new"]:
            raise PatchError(f"{entry['file']} 在打完补丁后被改过，拒绝回退")
        backup = src / entry["backup"]
        if not backup.is_file():
            raise PatchError(f"备份不见了：{backup}")
        if digest(backup.read_bytes()) != entry["old"]:
            raise PatchError(f"备份内容与记录的旧 hash 不符：{backup}")
    # 先把「已回退」写盘：即使恢复途中失败或断电，doctor 也不会自动打回去
    record["state"] = "rolled-back"
    write_json(record_path, record)
    for entry in reversed(entries):
        path = src / entry["file"]
        current = digest(path.read_bytes()) if path.is_file() else None
        if entry["old"] is None:
            if current is not None:
                path.unlink()
            continue
        if current == entry["old"]:
            continue
        os.replace(src / entry["backup"], path)
    print(f"rolled back {record['stamp']}（{len(entries)} 个文件）")
    print("自动修复已暂停：重跑补丁或删掉这条事务记录才会恢复。")
    return 0


def latest_record(support):
    records = sorted((Path(support) / "patch-transactions").glob("*.json"))
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

    try:
        if args.paused:
            return 0 if paused(args.support_dir) else 1
        if args.fingerprint is not None:
            patched = world_patched(read_text(Path(args.fingerprint) / "world.ts"))
            print(json.dumps({"world.ts": digest(patched.encode("utf-8"))}))
            return 0
        manifest = load_manifest(args.manifest)
        if args.rollback is not None:
            path = latest_record(args.support_dir) if args.rollback == "latest" else Path(args.rollback)
            return rollback(path)
        result = inspect(args.extension_dir, manifest, args.templates)
        if args.check or args.json:
            code = report(result, args.json)
            if args.check:
                return code
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
