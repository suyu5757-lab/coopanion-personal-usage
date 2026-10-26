Owner: `personal-voice/` (本目录的脚本与模板)

# 本地 GPT-SoVITS 语音

给 Coopanion 桌宠接一条完全本地的 GPT-SoVITS 语音：`streamvoice` 把模型输出按句切块，交给本机的
GPT-SoVITS 合成，再用 `afplay` 播放。旧的整段 TTS、重复播放器和内置音节声默认关闭。

## 当前语音

本机现在用「大肥鱼」C 组音色：v1 底模 GPT + v1 基础 SoVITS，情绪参考统一用 Rubber Band R2 crisp 6 升 2 半音；非中性情绪同时使用固定中性辅助参考。目前启用中性、生气、难过、开心四种，其他表情暂用中性声线。adapter 按 `pet_say` 的表情标记选参考音，未识别到表情时默认中性，正文关键词猜测关闭。

- 权重：SoVITS `~/Library/Application Support/Coopanion/tts/gpt-sovits/repo/GPT_SoVITS/pretrained_models/s2G488k.pth`；GPT 用 v1 底模 `s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt`
- 参考音：`~/Library/Application Support/Coopanion/tts/gpt-sovits/ref/da-fei-yu-C-*/`，实际路径与台词以 `adapter-config.json` 为准；旧参考音和训练权重保留
- 配置：`~/Library/Application Support/Coopanion/tts/adapter-config.json` 的 `emotion_refs`、`emotion_aliases`、`emotion_keywords`
- 训练数据：`~/Library/Application Support/Coopanion/tts/da-fei-yu-train/`
- 数据来源和许可：见 [models.md](models.md)
- `patch-streamvoice.py` 同时更新 `speaker.ts`、`clean.ts` 和 `world.ts`，把 `pet_say` 的 `【表情】` 传给 adapter；修改前校验三份源文件并逐份备份。扩展升级后需重新应用；`--check` 只检查，不修改。

`adapter-config.json` 可在全局或单个 `emotion_refs` 条目设置 `aux_ref_audio_paths`、`top_k`、`top_p`、`seed`、`parallel_infer`、`repetition_penalty`。单个情绪的值优先；`aux_ref_audio_paths: []` 可取消继承的辅助参考。辅助参考参与音色融合，不保证消除破音或固定音色，必须试听后选用。

明确的 `emotion`（如 `neutral`、`angry`、`sad`、`happy` 或配置中的中文别名）优先于正文。只有显式设置 `emotion_keyword_fallback: true` 时才用旧的关键词兜底；它会把“别生气”等否定句误判为生气。隔离运行可用 `COOPANION_TTS_CONFIG=/绝对路径/adapter-config.json python adapter.py`，并给该配置指定独立端口。

下面的安装步骤以三月七角色包为示例；本机已经改用大肥鱼，重跑会覆盖当前配置。

## 需要什么

- macOS，Apple Silicon，16 GB 内存以上
- Coopanion 0.2.8 或兼容版本
- 约 6 GB 磁盘：GPT-SoVITS 运行环境、v1 底模、示例角色包（三月七）
- 已安装 `cortico-world-streamvoice` 0.4.0（扩展市场搜索「流式语音播报」）

## 一键安装（三月七示例）

```bash
COOPANION_INSTALL_MARCH7=1 ./install-macos.sh
```

这条命令会覆盖当前的大肥鱼配置；本机不需要重跑。

脚本会依次完成：

1. 下载并安装 Python 3.10、PyTorch、GPT-SoVITS 推理依赖
2. 下载 v1 底模、G2PW、语种识别模型和 NLTK 数据
3. 下载示例角色包（三月七）并放到 `~/Library/Application Support/Coopanion/tts/`
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
- 当前大肥鱼音色来自 ModelScope「大肥鱼（自调少女音色）」数据集，作者尹紫鹭幻想社，CC BY-NC 4.0；本仓库不重新分发音频或权重
- 三月七角色包是安装脚本的示例素材，同样仅个人非商业使用；下载地址与许可见 [models.md](models.md)
- GPT-SoVITS 推理代码与底模为 MIT；本目录的适配器和补丁沿用 Coopanion 仓库的 AGPL-3.0
