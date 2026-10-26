#!/usr/bin/env python3
"""Reapply the GPT-SoVITS speaker and explicit emotion routing to streamvoice 0.4.0."""

import argparse
import shutil
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUPPORT = Path.home() / "Library/Application Support/Coopanion"
DEFAULT_SRC = SUPPORT / "extensions/node_modules/cortico-world-streamvoice/src"


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("streamvoice source differs from 0.4.0; no files changed")
    return text.replace(old, new, 1)


def emotion_clean(text):
    if "mood: string | undefined;" in text:
        if "this.note(this.hold.slice(i + 1, end));" not in text or "this.note(inner);" not in text:
            raise ValueError("incomplete existing emotion patch; no files changed")
        return text
    text = replace_once(text, "  private hold = '';", """  private hold = '';
  mood: string | undefined;

  private note(marker: string): void {
    const value = marker.trim();
    if (value) this.mood = value;
  }""")
    text = replace_once(text, "        if (end < 0) break;\n        i = end + 1;", "        if (end < 0) break;\n        this.note(this.hold.slice(i + 1, end));\n        i = end + 1;")
    text = replace_once(text, "        if (inner.length <= MARKER_MAX && !inner.includes('\\n')) {\n          i = end + 1;", "        if (inner.length <= MARKER_MAX && !inner.includes('\\n')) {\n          this.note(inner);\n          i = end + 1;")
    text = replace_once(text, "    this.hold = '';\n    return rest.replace", r"""    this.hold = '';
    const block = [...rest.matchAll(/【([^】]*)】/g)].pop();
    if (block) this.note(block[1]);
    const inline = [...rest.matchAll(/<([^<>\n]{1,32})>/g)].pop();
    if (inline) this.note(inline[1]);
    return rest.replace""")
    return text


def emotion_world(text):
    if "const mood = stream.filter.mood;" in text and "this.speaker.say(said, style);" in text:
        return text
    return replace_once(text, "    this.speaker.say(said, this.style);", """    const mood = stream.filter.mood;
    const style = mood ? { ...this.style, emotion: mood } : this.style;
    this.speaker.say(said, style);""")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extension-dir', type=Path, default=DEFAULT_SRC, help='streamvoice src directory')
    parser.add_argument('--check', action='store_true', help='validate without changing files')
    args = parser.parse_args()
    src = args.extension_dir
    try:
        # Validate every input before backing up or changing any installed source.
        updates = {
            src / 'speaker.ts': (HERE / 'speaker.gptsovits.ts').read_text(),
            src / 'clean.ts': emotion_clean((src / 'clean.ts').read_text()),
            src / 'world.ts': emotion_world((src / 'world.ts').read_text()),
        }
        for path in updates:
            if not path.is_file():
                raise FileNotFoundError(path)
    except (OSError, ValueError) as error:
        print(error)
        return 1
    changed = [path for path, text in updates.items() if path.read_text() != text]
    if args.check:
        print(f'Validated: {len(changed)} file(s) need the patch; no files changed.')
        return 0
    stamp = time.strftime('%Y%m%d-%H%M%S') + '-' + str(time.time_ns())
    for path in changed:
        backup = path.with_name(path.name + '.bak-' + stamp)
        shutil.copy2(path, backup)
        path.write_text(updates[path])
        print(f'patched {path}\nbackup  {backup}')
    print('Restart Coopanion to load changed extension files.' if changed else 'Patch already applied.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
