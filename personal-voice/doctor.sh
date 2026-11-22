#!/usr/bin/env bash
# 本机语音链路自检。默认只读：报告两个服务和补丁状态，不改文件、不碰 LaunchAgent、不重启应用。
# 只有显式 --repair 才按需恢复补丁或重启服务、应用；后台 LaunchAgent 只运行只读检查。
set -u

SUPPORT="${COOPANION_SUPPORT:-$HOME/Library/Application Support/Coopanion}"
VOICE="$SUPPORT/tts"
CONFIG="${COOPANION_TTS_CONFIG:-$VOICE/adapter-config.json}"
SRC="${COOPANION_STREAMVOICE_SRC:-$SUPPORT/extensions/node_modules/cortico-world-streamvoice/src}"
PATCHER="$VOICE/patch-streamvoice.py"
GPT_URL="${COOPANION_GPT_URL:-http://127.0.0.1:9880}"
ADAPTER_URL="${COOPANION_ADAPTER_URL:-http://127.0.0.1:9881}"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

REPAIR=0
# 开发测试时置 1：只报告并补文件，不碰 LaunchAgent、不重启应用
NO_RESTART="${COOPANION_DOCTOR_NO_RESTART:-0}"
for arg in "$@"; do
  case "$arg" in
    --repair) REPAIR=1 ;;
    --check) REPAIR=0 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) printf 'unknown argument: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

log() { printf '[voice-doctor %s] %s\n' "$STAMP" "$*"; }
healthy() { curl -fsS --max-time 3 "$1" >/dev/null 2>&1; }
restart_agent() {
  local label="$1" plist="$HOME/Library/LaunchAgents/$1.plist"
  launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null 2>&1 && return 0
  [ -f "$plist" ] && launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
}

PROBLEMS=0

# ---- 服务 ----
if healthy "$GPT_URL/docs"; then
  log "GPT-SoVITS $GPT_URL 正常"
else
  PROBLEMS=$((PROBLEMS + 1))
  log "GPT-SoVITS $GPT_URL 不可用"
  if [ "$REPAIR" -eq 1 ]; then
    if curl -sS --max-time 3 "$ADAPTER_URL/health" 2>/dev/null | grep -q '"engine": *"unknown"'; then
      log "适配器报告引擎状态未知：跳过 GPT-SoVITS 重启，先确认后端已空闲"
    elif [ "$NO_RESTART" -eq 0 ]; then
      log "重启 ai.coopanion.gpt-sovits"
      restart_agent ai.coopanion.gpt-sovits
    fi
  fi
fi

if healthy "$ADAPTER_URL/health"; then
  log "TTS 适配器 $ADAPTER_URL 正常"
elif curl -sS --max-time 3 "$ADAPTER_URL/health" 2>/dev/null | grep -q '"engine": *"unknown"'; then
  PROBLEMS=$((PROBLEMS + 1))
  log "适配器拒绝推理：上一次请求超时，引擎状态未知；确认 GPT-SoVITS 空闲后再重启适配器，别让新请求越过并发保护"
else
  PROBLEMS=$((PROBLEMS + 1))
  log "TTS 适配器 $ADAPTER_URL 不可用"
  if [ "$REPAIR" -eq 1 ] && [ "$NO_RESTART" -eq 0 ]; then
    log "重启 ai.coopanion.tts-adapter"
    restart_agent ai.coopanion.tts-adapter
  fi
fi

# ---- 补丁 ----
PATCH_CHANGED=0
if [ ! -f "$PATCHER" ]; then
  log "缺少 $PATCHER，无法核对补丁"
  PROBLEMS=$((PROBLEMS + 1))
elif python3 "$PATCHER" --paused --support-dir "$SUPPORT" 2>/dev/null; then
  log "上次是手动回退，保持原样：不再自动打补丁（重跑补丁即恢复）"
else
  STATUS="$(python3 "$PATCHER" --check --extension-dir "$SRC" --support-dir "$SUPPORT" 2>&1)"
  CODE=$?
  STATE="$(printf '%s\n' "$STATUS" | sed -n 's/^status: //p')"
  TRANSACTION="$(printf '%s\n' "$STATUS" | sed -n 's/^transaction: //p')"
  [ -n "$TRANSACTION" ] && log "补丁事务需要恢复：$TRANSACTION"
  case "$STATE" in
    patched) log "补丁已应用" ;;
    clean|patch)
      PROBLEMS=$((PROBLEMS + 1))
      log "补丁状态：$STATE"
      if [ "$REPAIR" -eq 1 ]; then
        OUTPUT="$(python3 "$PATCHER" --extension-dir "$SRC" --support-dir "$SUPPORT" 2>&1)"
        printf '%s\n' "$OUTPUT" | grep -q '^patched ' && PATCH_CHANGED=1
        log "已按需应用补丁"
      fi
      ;;
    *)
      PROBLEMS=$((PROBLEMS + 1))
      log "补丁状态：${STATE:-unknown}（退出码 $CODE）；上游版本或文件与清单不符，需要人工确认"
      ;;
  esac
fi

# ---- 参考音与权重 ----
if [ -f "$CONFIG" ]; then
  MISSING="$(python3 - "$CONFIG" <<'PY'
import json, os, sys
try:
    cfg = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception as error:
    print('配置读不出来：%s' % error)
    raise SystemExit(0)
paths = []
default = cfg.get('ref_audio_path')
if default:
    paths.append(('默认', default))
for name, item in (cfg.get('emotion_refs') or {}).items():
    if isinstance(item, dict) and item.get('ref_audio_path'):
        paths.append((name, item['ref_audio_path']))
    if isinstance(item, dict):
        for aux in item.get('aux_ref_audio_paths') or []:
            paths.append((name + ' 辅助', aux))
for aux in cfg.get('aux_ref_audio_paths') or []:
    paths.append(('辅助', aux))
seen = set()
for name, path in paths:
    resolved = os.path.expanduser(path)
    if resolved in seen:
        continue
    seen.add(resolved)
    if not os.path.isfile(resolved):
        print('%s 参考音缺失：%s' % (name, resolved))
PY
)"
  if [ -n "$MISSING" ]; then
    PROBLEMS=$((PROBLEMS + 1))
    printf '%s\n' "$MISSING" | while IFS= read -r line; do log "$line"; done
  else
    log "参考音文件齐全"
  fi
else
  log "没有适配器配置：$CONFIG"
fi

# ---- 应用重启：只在补丁真的变过时做 ----
if [ "$NO_RESTART" -eq 1 ]; then
  [ "$PATCH_CHANGED" -eq 1 ] && log "跳过应用重启（COOPANION_DOCTOR_NO_RESTART=1）"
elif [ "$PATCH_CHANGED" -eq 1 ] && pgrep -f "/Applications/Coopanion.app/Contents/MacOS/Coopanion" >/dev/null 2>&1; then
  log "补丁变了，重启安装版 Coopanion"
  osascript -e 'quit app "Coopanion"' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    pgrep -f "/Applications/Coopanion.app/Contents/MacOS/Coopanion" >/dev/null 2>&1 || break
    sleep 1
  done
  open -a Coopanion >/dev/null 2>&1 || true
fi

if [ "$PROBLEMS" -eq 0 ]; then
  log "全部正常"
  exit 0
fi
exit 1
