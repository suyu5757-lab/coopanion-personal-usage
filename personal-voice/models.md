Owner: `personal-voice/`

# 语音模型文件

这个目录不包含模型权重。当前本机用「大肥鱼」音色；下面的三月七角色包是 `install-macos.sh` 的示例。

## 当前音色：大肥鱼

- 数据集：<https://www.modelscope.cn/datasets/YinZilu/da-fei-yu-girl-voice-zh>
- 作者：尹紫鹭幻想社（Bilibili）
- 许可：CC BY-NC 4.0，仅个人非商业使用；本仓库不重新分发音频或权重
- 内容：145 条中文语音，约 18 分 29 秒；本机用一组同说话人片段升高 2 半音作为多情绪参考音
- 本地音色配置、权重和参考音由使用者自行准备；适配器设置见 [README.md](README.md)。
- 参考音：`da-fei-yu/` 目录，台词和语速见 `refs.json`

## 示例角色包：三月七

- 地址：<https://huggingface.co/baicai1145/GPT-SoVITS-STAR/resolve/main/%E4%B8%89%E6%9C%88%E4%B8%83.zip>
- 大小：约 222 MB
- 内容：`三月七-e10.ckpt`（GPT 权重）、`三月七_e15_s4875.pth`（SoVITS 权重）、参考音频及其台词
- 用途：个人、非商业使用；仓库不重新分发该角色包，请从原作者页面下载
- 参考台词：`名字是我自己取的，大家也叫我三月、小三月…你呢？你想叫我什么？`

## GPT-SoVITS v1 底模

- 仓库：<https://huggingface.co/lj1995/GPT-SoVITS>
- `s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt`
- `s2G488k.pth`
- `chinese-hubert-base/`（`config.json`、`preprocessor_config.json`、`pytorch_model.bin`）
- `chinese-roberta-wwm-ext-large/`（`config.json`、`pytorch_model.bin`、`tokenizer.json`）

## 文本前端

- G2PW：<https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/G2PWModel.zip>
- 语种识别：<https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models/fast_langdetect/lid.176.bin>
- NLTK：`averaged_perceptron_tagger`、`averaged_perceptron_tagger_eng`、`cmudict`，放在 `~/nltk_data/`

## 许可

GPT-SoVITS 代码与底模为 MIT。大肥鱼数据集与三月七角色包均为社区素材，按各自许可仅个人非商业使用；使用前请阅读原模型卡。仓库只保存配置和脚本，不保存音频或权重。
