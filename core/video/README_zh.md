<!-- Owner: world.ts, library.ts, manifest.ts, render.ts, prepared.ts, tools.ts, definition.ts, model-text.ts -->

# core/video

视频 World。`video_list_media` 列出本地素材；`video_render` 按编辑清单生成竖屏 MP4，检查成片并返回本次 Core 会话的 `renderId` 与 SHA-256。

- `manifest.ts` 校验画布、素材、剪辑、音轨、字幕和输出路径。素材必须位于 `<data>/video/media`，输出必须是 `<data>/video/renders` 中的新 `.mp4` 路径。素材和音轨需要填写使用依据。
- `library.ts` 按相对路径、类型和大小列出图片、视频和音频，不跟随符号链接，每次最多列出 200 个文件。
- `render.ts` 调用 FFmpeg 剪辑、缩放、拼接和混音，再用 ffprobe 检查分辨率、时长、编码和文件大小，执行黑屏检测并截取预览帧。已有成片不会被覆盖；临时文件存放在 `<data>/video/work/render-*`，任务结束后清理。
- `video_prepare_upload` 根据本次会话中的 `renderId` 重新检查源文件路径、MP4 文件签名、字节数、SHA-256 和 ffprobe 结果，将成片复制到 `<data>/video/media/prepared/<renderId>/render.mp4`，再核对副本。旁边的 `receipt.json` 保存校验结果。此文件可由现有 Browser 媒体 allowlist 读取，网页上传仍须单独审批。
- 字幕默认另存为同名 `.srt`。烧录字幕需要带 `drawtext` 的 FFmpeg。
- FFmpeg 与 ffprobe 使用设置路径或 `COOPANION_FFMPEG` / `COOPANION_FFPROBE`，否则从常用安装位置和 `PATH` 查找；回执记录所用程序及版本。

`tests/video.test.ts` 覆盖清单校验、真实渲染与待上传素材交接；真实媒体测试在缺少 ffmpeg 时跳过。
