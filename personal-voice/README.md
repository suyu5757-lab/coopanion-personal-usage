Owner: `personal-voice/` (本目录的脚本与模板)

# 本地三月七语音

给 Coopanion 桌宠接一条完全本地的 GPT-SoVITS 语音：`streamvoice` 把模型输出按句切块，交给本机的
GPT-SoVITS 合成，再用 `afplay` 播放。旧的整段 TTS、重复播放器和内置音节声默认关闭。

## 需要什么

- macOS，Apple Silicon，16 GB 内存以上
- Coopanion 0.2.8 或兼容版本
- 约 6 GB 磁盘：GPT-SoVITS 运行环境、v1 底模、三月七角色包
- 已安装 `cortico-world-streamvoice` 0.4.0（扩展市场搜索「流式语音播报」）

## 一键安装

```bash
./install-macos.sh
```

脚本会依次完成：

1. 下载并安装 Python 3.10、PyTorch、GPT-SoVITS 推理依赖
2. 下载 v1 底模、G2PW、语种识别模型和 NLTK 数据
3. 下载三月七角色包并放到 `~/Library/Application Support/Coopanion/tts/`
4. 写入 `tts_infer.yaml`、`adapter.py` 和适配器配置
5. 安装两个 LaunchAgent（登录后自动启动 GPT-SoVITS 与桥接）
6. 给已安装的 `streamvoice` 打本地 GPT-SoVITS 补丁
7. 更新 `worlds.streamvoice` 等配置

脚本不会重启 Coopanion；装完后手动退出并重新打开应用。

## 手动安装

如果已经有现成环境，只需复制文件：

```bash
# 运行环境放在
~/Library/Application Support/Coopanion/tts/
├─ adapter.py
├─ adapter-config.json
├─ gpt-sovits/
│  ├─ repo/          # GPT-SoVITS
│  ├─ venv/
│  ├─ tts_infer.yaml
│  └─ ref/march7.wav
└─ march7/           # 角色包解压目录
```

然后：

```bash
python3 patch-streamvoice.py          # 覆盖 streamvoice 的 speaker.ts
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.coopanion.gpt-sovits.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.coopanion.tts-adapter.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.coopanion.voice-doctor.plist
```

`config-fragment.json` 是需要合并进 `config.json` 的 `worlds` 片段：打开 `streamvoice`，关掉
`tts.autoSpeak`、`audio-play`、内置 `speech` 和 `sounds.talk`，避免同一句被念两遍。

## 为什么需要补丁

原版 `streamvoice` 只接 Edge TTS。`speaker.gptsovits.ts` 把合成那一步换成
`POST http://127.0.0.1:9881/v1/audio/speech`，本地桥接再调用 GPT-SoVITS；切句、队列、`afplay`
和打断逻辑保持原样。`speaker.original.ts` 是原文件备份，方便对比或回退。

## 后台自检

`install-macos.sh` 还会安装 `ai.coopanion.voice-doctor`，每 5 分钟检查一次：

- GPT-SoVITS（9880）和适配器（9881）是否健康，不健康就重启对应的 LaunchAgent
- `streamvoice/src/speaker.ts` 里是否还有 `TTS_URL`，没有就复制 `speaker.gptsovits.ts` 恢复
- 补丁确实被覆盖时，才重启安装版 Coopanion 让新代码生效

日志在 `~/Library/Application Support/Coopanion/tts/doctor.log`。手动执行：

```bash
~/Library/Application\ Support/Coopanion/tts/doctor.sh
```

这一步只保证补丁和服务；模型权重、`config.json`、API Key 仍需要自己备份。

## 更新后

`streamvoice` 升级或重新安装会覆盖 `speaker.ts`。正常等 doctor 最多 5 分钟自动恢复；想立即恢复就重跑：

```bash
python3 patch-streamvoice.py
```

并重启 Coopanion。脚本每次都会在扩展目录留一份 `speaker.ts.bak-*`。

## 隐私与许可

- 合成、播放、模型都在本机；只有首次安装会下载模型
- 三月七角色包来自社区，仅供个人非商业使用；本仓库不重新分发权重，下载地址与许可见 [models.md](models.md)
- GPT-SoVITS 推理代码与底模为 MIT；本目录的适配器和补丁沿用 Coopanion 仓库的 AGPL-3.0
