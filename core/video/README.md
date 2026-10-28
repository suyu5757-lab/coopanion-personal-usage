<!-- Owner: world.ts, library.ts, manifest.ts, render.ts, tools.ts, definition.ts -->

# core/video

The video World. `video_list_media` lists local media paths; `video_render` turns an `edit-manifest`
into a vertical preview MP4 and checks the file that came out.

- `manifest.ts` is the contract and the boundary: canvas, authorized sources, clips, optional music,
  voice-over and captions, output path. Every path must resolve inside the deployment's
  `<data>/video/media`; the output must be an `.mp4` under `<data>/video/renders`. Sources and audio
  must carry a rights note.
- `library.ts` lists supported images, videos and audio by relative path, type and size. It does not
  follow symlinks and returns at most 200 files.
- `render.ts` compiles the manifest into one FFmpeg command (trim, fit to the canvas, concat, mix
  audio, H.264/AAC, `+faststart`), then verifies the result with ffprobe and `blackdetect` and takes
  one poster frame. Intermediates live in `<data>/video/work/render-*` and are removed in `finally`;
  sources are never written to.
- Captions are written beside the video as an `.srt` of the same name. Burning text into the picture
  needs an FFmpeg built with libfreetype (`drawtext`); the development build on this machine has no
  such filter, so the renderer does not depend on it.
- FFmpeg and ffprobe are found with `COOPANION_FFMPEG` / `COOPANION_FFPROBE`, then on `PATH`. Each
  receipt names the binary and version it used. The packaged app's own discovery is a separate
  acceptance item and is not claimed here.
- `world.ts` keeps both tools and their receipts; `tools.ts` declares their schemas; `model-text.ts`
  holds the Chinese and English receipts.

`tests/video.test.ts` covers validation and one real render from self-made lavfi clips, skipped when
this machine has no ffmpeg.
