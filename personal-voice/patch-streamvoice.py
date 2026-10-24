#!/usr/bin/env python3
"""Reapply the local GPT-SoVITS patch to an installed streamvoice extension."""

import shutil
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SUPPORT = Path.home() / "Library/Application Support/Coopanion"
EXT = SUPPORT / "extensions/node_modules/cortico-world-streamvoice/src/speaker.ts"
PATCHED = HERE / "speaker.gptsovits.ts"


def main() -> int:
    if not EXT.exists():
        print(f"streamvoice is not installed: {EXT}")
        print("Install cortico-world-streamvoice 0.4.0 from the extension market first.")
        return 1
    if not PATCHED.exists():
        print(f"missing bundled patch: {PATCHED}")
        return 1
    backup = EXT.with_name(f"speaker.ts.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(EXT, backup)
    shutil.copy2(PATCHED, EXT)
    print(f"patched {EXT}")
    print(f"backup  {backup}")
    print("Restart Coopanion to load the patched extension.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
