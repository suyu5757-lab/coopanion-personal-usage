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
- `patch-streamvoice.py` 换掉 `speaker.ts`、新增 `speech-plan.ts`，并改 `world.ts` 的几处：每段台词带着自己的情绪和来源位置进播放队列。修改前先核对 `clean.ts`、`chunker.ts`、`world.ts`、`speaker.ts` 的 sha256，任何一份对不上就整次不动。事务清单在首次替换前落盘；异常退出后，下次显式应用会先按哈希恢复未完成事务，再重新应用。`--check` 和 `--json` 只报告状态：`clean`（原版可打）、`patch`（部分补丁或待恢复事务）、`patched`、`incompatible`（上游版本变了）、`missing`（扩展源码目录不存在）。

adapter 的 `GET /capabilities` 返回当前参考音、别名、健康状态和配置指纹（只给文件名，不给目录）；`/v1/audio/speech` 的成功响应带 `X-Coopanion-Reference`、`X-Coopanion-Capability`，降级时带 `X-Coopanion-Fallback`。参考音文件读不出来时先退到健康的中性参考，中性也不可用就返回 503，让这一句只留在气泡里。同一台模型一次只跑一条推理：旧请求还在算时新请求短暂等待，等不到就收到 429 `busy`，客户端把这一段当文字处理，不排队堆积。

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
`POST http://127.0.0.1:9881/v1/audio/speech`，本地桥接再调用 GPT-SoVITS。

`hush()` 中止正在进行的合成请求（连响应体一起），所以新回复不用等旧请求自己超时；试听和正常朗读排在同一条播放流水线上，进播放器之前再复核一次代次，取消过的声音不会晚一步补放。合成有总时限（`requestTimeoutMs`，默认 30 秒）、单响应字节上限和排队上限；超出的人只留在气泡里，日志记一次「语音省略」。播放前检查返回值是不是真的 WAV，并读出实际采样率、声道和时长。

`speech-plan.ts` 负责去标记和切句：每个标记记下它在正文里的位置，切块后按位置分给对应的句段，所以同一段文字不管被切成几个增量，情绪都不会变。只把 adapter 能力清单里认得的标记当情绪，`<点头>` 这类动作不会顶掉上一句的「开心」；能力清单拿不到时退回旧规则（任何标记都算情绪）。

`speaker.original.ts` 是 0.4.0 原文件备份，方便对比或回退。

## 后台自检

`install-macos.sh` 还会安装 `ai.coopanion.voice-doctor`。它登录后和每 5 分钟运行一次只读检查：

- GPT-SoVITS（9880）和适配器（9881）是否健康
- 补丁状态是否为 `patched`；`clean`、`patch`、`incompatible` 和未完成事务都会报告
- 适配器如果因为上游超时进入「引擎状态未知」，报出来并让人确认后端空闲，不自动重启
- 适配器配置里每个参考音文件是否都在
- 显式 `--repair` 时，才修复补丁或在安全条件满足时重启服务、应用

不带参数或带 `--check` 时**只报告，不改文件、不动 LaunchAgent、不重启服务或应用**，可以随时拿来审计：

```bash
~/Library/Application\ Support/Coopanion/tts/doctor.sh --check
```

日志在 `~/Library/Application Support/Coopanion/tts/doctor.log`。开发时加 `COOPANION_DOCTOR_NO_RESTART=1`，`--repair` 也只补文件，不重启服务和应用。

`--repair` 需要人工显式运行。它会按需恢复补丁，并在服务不健康且引擎状态已知时重启对应服务；适配器报告 `engine=unknown` 时不会重启 GPT-SoVITS 或适配器。补丁确实变化且安装版正在运行时，才会重启 Coopanion。后台 LaunchAgent 不会调用 `--repair`。

这一步只保证补丁和服务；模型权重、`config.json`、API Key 仍需要自己备份。

## 更新后

`streamvoice` 升级或重新安装会重置扩展文件。先看状态：

```bash
python3 patch-streamvoice.py --check
```

`clean` 或 `patch` 就再跑一次不带参数的同一命令。装了旧版补丁、模板又更新过时状态会是 `incompatible`：先 `--rollback` 回到原版，再应用新版；上游不是 0.4.0 时不要这样升级，先更新 `patch-manifest.json` 与锚点。每次成功应用都在 `~/Library/Application Support/Coopanion/patch-transactions/` 留一份事务清单（旧 hash、新 hash、备份位置），回退：

```bash
python3 patch-streamvoice.py --rollback
```

回退会把清单标成 `rolled-back`，doctor 看到这个状态就不再自动打补丁；重跑补丁即恢复自动修复。改完重启 Coopanion 才会加载。

## 隔离运行

开发和测试不需要安装版：

```bash
COOPANION_SUPPORT=/tmp/coopanion-support \
COOPANION_STREAMVOICE_SRC=/tmp/ext/src \
COOPANION_TTS_CONFIG=/tmp/adapter.json \
COOPANION_TTS_URL=http://127.0.0.1:19881/v1/audio/speech \
python3 patch-streamvoice.py --check
```

这个目录里的按 `test_*.py` 一起跑：

```bash
python3 -m unittest discover -s personal-voice -p 'test_*.py'
```

## 版本化测试 Runtime

`runtime.py` 按 `plan → stage → check → start-test → stop-test → rollback` 管理一个隔离 Voice Runtime。它只接受 `~/Library/Application Support/Coopanion Test/<runId>/` 或 `scratch/<runId>/` 下的 Runtime 目录，不修改 `install-macos.sh`、生产配置或 LaunchAgent。

Runtime 计划为每个待复制文件和只读资产记录 SHA-256、Python 完整版本、专用 engine/adapter 端口、loopback 健康检查和两个子进程的启动配置。只读资产须先放入本次 run 目录，使用只读权限且不是硬链接；工具只引用它们，不复制、改权或删除。计划不能包含 API Key、密钥字段或生产端口 `9880/9881`。

```bash
python3 personal-voice/runtime.py plan /path/to/runtime-spec.json
python3 personal-voice/runtime.py stage /path/to/runtime-spec.json
python3 personal-voice/runtime.py check /absolute/path/to/runtime --run-id r1-example-01
python3 personal-voice/runtime.py start-test /absolute/path/to/runtime --run-id r1-example-01
python3 personal-voice/runtime.py stop-test /absolute/path/to/runtime --run-id r1-example-01
python3 personal-voice/runtime.py rollback /absolute/path/to/runtime --run-id r1-example-01
```

`plan` 只核对来源哈希、Python 版本和端口，不写文件。`rollback` 只移除仍与 manifest 哈希相符的 staged 文件；被修改的文件、参考资产、运行日志和 manifest 留在原处供检查。测试阶段不注册 LaunchAgent。

## 隐私与许可

- 合成、播放、模型都在本机；只有首次安装会下载模型
- 当前大肥鱼音色来自 ModelScope「大肥鱼（自调少女音色）」数据集，作者尹紫鹭幻想社，CC BY-NC 4.0；本仓库不重新分发音频或权重
- 三月七角色包是安装脚本的示例素材，同样仅个人非商业使用；下载地址与许可见 [models.md](models.md)
- GPT-SoVITS 推理代码与底模为 MIT；本目录的适配器和补丁沿用 Coopanion 仓库的 AGPL-3.0
