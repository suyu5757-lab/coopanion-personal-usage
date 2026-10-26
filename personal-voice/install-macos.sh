#!/usr/bin/env bash
# Install the March 7th GPT-SoVITS example voice. The current machine uses the
# 大肥鱼 voice; running this overwrites its config.
# Downloads the runtime, base weights and the character pack, then patches
# the streamvoice extension and enables the voice in companion/config.json.
set -euo pipefail

if [ "${COOPANION_INSTALL_MARCH7:-}" != "1" ]; then
  echo "This installs the March 7 example voice and overwrites the current 大肥鱼 config."
  echo "Set COOPANION_INSTALL_MARCH7=1 to continue."
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPPORT="${COOPANION_SUPPORT:-$HOME/Library/Application Support/Coopanion}"
VOICE="$SUPPORT/tts"
GS="$VOICE/gpt-sovits"
REPO="$GS/repo"
VENV="$GS/venv"
PM="$REPO/GPT_SoVITS/pretrained_models"
HF="https://huggingface.co/lj1995/GPT-SoVITS/resolve/main"
NLTK="$HOME/nltk_data"
export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"

say() { printf '\n== %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少 $1"; exit 1; }; }
fetch() {
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then return 0; fi
  mkdir -p "$(dirname "$dest")"
  curl -L --fail --retry 3 --progress-bar "$url" -o "$dest"
}

need git
need curl
need unzip
need ffmpeg
need python3
if ! command -v uv >/dev/null 2>&1; then
  say "安装 uv"
  python3 -m pip install --user uv
  export PATH="$HOME/Library/Python/3.9/bin:$HOME/.local/bin:$PATH"
fi

say "目录"
mkdir -p "$GS" "$GS/ref" "$PM/chinese-hubert-base" "$PM/chinese-roberta-wwm-ext-large" "$PM/fast_langdetect" "$REPO/GPT_SoVITS/text"

if [ ! -d "$REPO/.git" ]; then
  say "克隆 GPT-SoVITS"
  git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git "$REPO"
fi
if [ ! -x "$VENV/bin/python" ]; then
  say "创建 Python 3.10 环境"
  uv venv --python 3.10 "$VENV"
fi
if [ ! -f "$VENV/.voice-installed" ]; then
  say "安装 PyTorch 与推理依赖"
  uv pip install --python "$VENV/bin/python" torch==2.7.1 torchaudio==2.7.1
  uv pip install --python "$VENV/bin/python" -r "$REPO/requirements.txt" resampy
  touch "$VENV/.voice-installed"
fi

say "下载 v1 底模"
fetch "$HF/s1bert25hz-2kh-longer-epoch%3D68e-step%3D50232.ckpt" \
  "$PM/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt"
fetch "$HF/s2G488k.pth" "$PM/s2G488k.pth"
for file in config.json preprocessor_config.json pytorch_model.bin; do
  fetch "$HF/chinese-hubert-base/$file" "$PM/chinese-hubert-base/$file"
done
for file in config.json pytorch_model.bin tokenizer.json; do
  fetch "$HF/chinese-roberta-wwm-ext-large/$file" "$PM/chinese-roberta-wwm-ext-large/$file"
done
fetch "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models/fast_langdetect/lid.176.bin" \
  "$PM/fast_langdetect/lid.176.bin"
if [ ! -d "$REPO/GPT_SoVITS/text/G2PWModel" ]; then
  fetch "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip" \
    "$REPO/GPT_SoVITS/text/G2PWModel.zip"
  unzip -q -o "$REPO/GPT_SoVITS/text/G2PWModel.zip" -d "$REPO/GPT_SoVITS/text"
fi

say "下载 NLTK 数据"
mkdir -p "$NLTK/taggers" "$NLTK/corpora"
for pkg in taggers/averaged_perceptron_tagger taggers/averaged_perceptron_tagger_eng corpora/cmudict; do
  name="${pkg##*/}"
  if [ ! -d "$NLTK/$pkg" ]; then
    fetch "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/$pkg.zip" "/tmp/$name.zip"
    unzip -q -o "/tmp/$name.zip" -d "$NLTK"
    mkdir -p "$NLTK/$(dirname "$pkg")"
    rm -rf "$NLTK/$pkg"
    mv "$NLTK/$name" "$NLTK/$pkg"
  fi
done

say "下载三月七角色包"
M7="$VOICE/march7"
if [ ! -f "$M7/三月七-e10.ckpt" ]; then
  fetch "https://huggingface.co/baicai1145/GPT-SoVITS-STAR/resolve/main/%E4%B8%89%E6%9C%88%E4%B8%83.zip" "$VOICE/march7.zip"
  python3 - "$VOICE/march7.zip" "$M7" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
with zipfile.ZipFile(src) as z:
    for info in z.infolist():
        raw = info.filename
        try:
            name = raw.encode('cp437').decode('gbk')
        except Exception:
            name = raw
        dest = os.path.join(out, name)
        if info.is_dir():
            os.makedirs(dest, exist_ok=True)
            continue
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with z.open(info) as r, open(dest, 'wb') as w:
            w.write(r.read())
PY
fi
mkdir -p "$PM/march7"
cp "$M7/三月七-e10.ckpt" "$PM/march7/march7-e10.ckpt"
cp "$M7/三月七_e15_s4875.pth" "$PM/march7/march7_e15_s4875.pth"
ref="$(find "$M7/参考音频" -name '*.wav' -print -quit)"
[ -n "$ref" ] && cp "$ref" "$GS/ref/march7.wav"

say "写入推理与适配器配置"
cp "$HERE/tts_infer.example.yaml" "$GS/tts_infer.yaml"
cp "$HERE/adapter.py" "$VOICE/adapter.py"
cp "$HERE/doctor.sh" "$VOICE/doctor.sh"
cp "$HERE/speaker.gptsovits.ts" "$VOICE/speaker.gptsovits.ts"
cp "$HERE/speaker.original.ts" "$VOICE/speaker.original.ts"
chmod +x "$VOICE/doctor.sh"
python3 - "$HERE/adapter-config.example.json" "$VOICE/adapter-config.json" "$VOICE" <<'PY'
import json, sys
src, dest, voice = sys.argv[1:4]
data = json.load(open(src, encoding='utf-8'))
data['ref_audio_path'] = data['ref_audio_path'].replace('__VOICE__', voice)
json.dump(data, open(dest, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY

say "安装 LaunchAgents"
mkdir -p "$HOME/Library/LaunchAgents"
for name in ai.coopanion.gpt-sovits ai.coopanion.tts-adapter ai.coopanion.voice-doctor; do
  sed "s|__HOME__|$HOME|g" "$HERE/launchagents/$name.plist.in" > "$HOME/Library/LaunchAgents/$name.plist"
  launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$name.plist" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$name.plist"
done

say "给 streamvoice 打本地 GPT-SoVITS 补丁"
python3 "$HERE/patch-streamvoice.py" || true

say "更新 worlds 配置"
CFG="$SUPPORT/home/companion/config.json"
if [ -f "$CFG" ]; then
  cp "$CFG" "$CFG.bak-voice-$(date +%Y%m%d-%H%M%S)"
  python3 - "$CFG" "$HERE/config-fragment.json" <<'PY'
import json, sys
cfg_path, frag_path = sys.argv[1:3]
cfg = json.load(open(cfg_path, encoding='utf-8'))
frag = json.load(open(frag_path, encoding='utf-8'))

def merge(dst, src):
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            merge(dst[key], value)
        else:
            dst[key] = value

merge(cfg.setdefault('worlds', {}), frag['worlds'])
json.dump(cfg, open(cfg_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
fi

say "完成"
echo "测试：curl -s http://127.0.0.1:9881/health"
echo "重启 Coopanion 后，桌宠会使用示例的三月七语音。当前机器已改用大肥鱼，不要重跑本脚本。"
echo "streamvoice 更新后补丁会被覆盖，重跑：python3 $HERE/patch-streamvoice.py"
