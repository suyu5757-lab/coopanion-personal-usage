<!-- Owner: world.ts, library.ts, manifest.ts, render.ts, prepared.ts, tools.ts, definition.ts, model-text.ts; ../action-authorization.ts and ../action-gate.ts -->

# core/video

The video World. `video_list_media` lists local media paths; `video_render` turns an `edit-manifest`
into a vertical preview MP4 and checks the file that came out. Each render returns a session-scoped
`renderId` and SHA-256.

- `manifest.ts` is the contract and the boundary: canvas, authorized sources, clips, optional music,
  voice-over and captions, output path. Every path must resolve inside the deployment's
  `<data>/video/media`; the output must be an `.mp4` under `<data>/video/renders`. Sources and audio
  must carry a rights note.
- `library.ts` lists supported images, videos and audio by relative path, type and size. It does not
  follow symlinks and returns at most 200 files.
- `render.ts` compiles the manifest into one FFmpeg command (trim, fit to the canvas, concat, mix
  audio, H.264/AAC, `+faststart`), then verifies the result with ffprobe and `blackdetect` and takes
  one poster frame. It refuses to overwrite an existing render. Intermediates live in
  `<data>/video/work/render-*` and are removed in `finally`; sources are never written to.
- `video_prepare_upload` accepts a `renderId` created in the current Core session. `prepared.ts`
  checks the render path, MP4 signature, byte length, SHA-256 and ffprobe facts, then copies it to
  `<data>/video/media/prepared/<renderId>/render.mp4` and verifies the copy. The `receipt.json` beside
  it records the checked file facts. The copy is eligible for the existing browser media allowlist;
  browser upload still needs its own approval.
- Before either tool writes, the Core asks for one approval bound to the output path, input digest and
  known output files. The shared action ledger records the approval, dispatch and file read-back;
  cancelled or unresolved writes stay visible for review. Render outputs and caption sidecars must
  be new files; existing files are preserved.
- Captions are written beside the video as an `.srt` of the same name. Burning text into the picture
  needs an FFmpeg built with libfreetype (`drawtext`); the development build on this machine has no
  such filter, so the renderer does not depend on it.
- FFmpeg and ffprobe are found with `COOPANION_FFMPEG` / `COOPANION_FFPROBE`, then on `PATH`. Each
  receipt names the binary and version it used. The packaged app's own discovery is a separate
  acceptance item and is not claimed here.
- `world.ts` keeps both tools and their receipts; `tools.ts` declares their schemas; `model-text.ts`
  holds the Chinese and English receipts.

`tests/video.test.ts` covers validation, a real render and prepared-media handoff from self-made
lavfi clips, skipped when this machine has no ffmpeg.
