#!/usr/bin/env bash
# Keep the local GPT-SoVITS voice alive: check both services, restore the
# streamvoice patch if an extension update overwrote it, and restart the
# installed app only when the patch actually changed.
set -u

SUPPORT="${COOPANION_SUPPORT:-$HOME/Library/Application Support/Coopanion}"
VOICE="$SUPPORT/tts"
EXT="$SUPPORT/extensions/node_modules/cortico-world-streamvoice/src/speaker.ts"
PATCHED="$VOICE/speaker.gptsovits.ts"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

log() { printf '[voice-doctor %s] %s\n' "$STAMP" "$*"; }

healthy() { curl -fsS --max-time 3 "$1" >/dev/null 2>&1; }

restart_agent() {
  local label="$1"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null 2>&1 && return 0
  [ -f "$plist" ] && launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
}

if ! healthy "http://127.0.0.1:9880/docs"; then
  log "GPT-SoVITS 9880 不可用，重启"
  restart_agent "ai.coopanion.gpt-sovits"
fi

if ! healthy "http://127.0.0.1:9881/health"; then
  log "TTS 适配器 9881 不可用，重启"
  restart_agent "ai.coopanion.tts-adapter"
fi

if [ -f "$EXT" ] && [ -f "$PATCHED" ]; then
  if ! grep -q "TTS_URL" "$EXT"; then
    cp "$EXT" "$EXT.bak-doctor-$(date +%Y%m%d-%H%M%S)"
    cp "$PATCHED" "$EXT"
    log "streamvoice 补丁被覆盖，已恢复"
    if pgrep -f "/Applications/Coopanion.app/Contents/MacOS/Coopanion" >/dev/null 2>&1; then
      log "重启安装版 Coopanion 以加载补丁"
      osascript -e 'quit app "Coopanion"' >/dev/null 2>&1 || true
      for _ in $(seq 1 20); do
        pgrep -f "/Applications/Coopanion.app/Contents/MacOS/Coopanion" >/dev/null 2>&1 || break
        sleep 1
      done
      open -a Coopanion >/dev/null 2>&1 || true
    fi
  fi
else
  log "streamvoice 未安装或补丁文件缺失，跳过补丁检查"
fi

[ -f "$VOICE/gpt-sovits/ref/march7.wav" ] || log "缺少参考音频，请运行 personal-voice/install-macos.sh"
[ -f "$VOICE/gpt-sovits/repo/GPT_SoVITS/pretrained_models/march7/march7-e10.ckpt" ] \
  || log "缺少三月七权重，请运行 personal-voice/install-macos.sh"
