/** Tool declarations for the video World. Descriptions are English; receipts are in `model-text.ts`. */
import type { ToolDef } from 'cortico/core/types.ts';

const track = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Audio file inside the media folder, e.g. assets/music.mp3.' },
    rights: { type: 'string', description: 'Why this audio may be used, e.g. "user-provided" or a licence name.' },
    startSec: { type: 'number', minimum: 0, description: 'Where the audio starts; default 0.' },
    gainDb: { type: 'number', minimum: -30, maximum: 12, description: 'Volume change in dB; default 0.' },
    loop: { type: 'boolean', description: 'Repeat short audio until the video ends.' },
  },
  required: ['path', 'rights'],
};

export const VIDEO_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'video_list_media',
    tags: ['read'],
    description: 'List image, video and audio files under the video media folder by relative path, type and size. It does not read file contents.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'video_render',
    tags: ['act'],
    interruptible: true,
    description: 'Render one vertical preview MP4 from source clips the person has put in the media folder. '
      + 'The manifest names the canvas, the authorized sources, the clips cut from them, optional music, voice-over and captions, and the output path under the renders folder. '
      + 'Sources are only read. The result is checked with ffprobe (size, duration, codecs) and for long black stretches; a poster frame comes back with the receipt. '
      + 'Captions are written beside the video as an .srt. Set captionsBurnIn to true to also draw them into the picture; that requires an FFmpeg build with drawtext.',
    parameters: {
      type: 'object',
      properties: {
        manifest: {
          type: 'object',
          description: 'The edit manifest.',
          properties: {
            canvas: {
              type: 'object',
              properties: {
                width: { type: 'integer', minimum: 240, maximum: 3840, description: 'Even width in pixels; 1080 for a vertical preview.' },
                height: { type: 'integer', minimum: 240, maximum: 3840, description: 'Even height in pixels; 1920 for a vertical preview.' },
                fps: { type: 'integer', minimum: 1, maximum: 60 },
              },
              required: ['width', 'height', 'fps'],
            },
            sources: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Short id used by clips, e.g. s1.' },
                  path: { type: 'string', description: 'File inside the media folder, e.g. assets/clip01.mp4.' },
                  rights: { type: 'string', description: 'Why this file may be used, e.g. "user-provided".' },
                },
                required: ['id', 'path', 'rights'],
              },
            },
            clips: {
              type: 'array',
              minItems: 1,
              maxItems: 40,
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string', description: 'A source id.' },
                  startSec: { type: 'number', minimum: 0 },
                  durationSec: { type: 'number', minimum: 0.1, maximum: 60 },
                  fit: { type: 'string', enum: ['contain', 'cover'], description: 'contain pads to the canvas; cover fills and crops. Default contain.' },
                },
                required: ['source', 'startSec', 'durationSec'],
              },
            },
            audio: {
              type: 'object',
              properties: { music: track, voiceover: track },
            },
            captions: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', maxLength: 200 },
                  startSec: { type: 'number', minimum: 0 },
                  durationSec: { type: 'number', minimum: 0.1 },
                },
                required: ['text', 'startSec', 'durationSec'],
              },
            },
            captionsBurnIn: { type: 'boolean', description: 'Also draw the captions into the picture. Requires an FFmpeg build with drawtext; default false.' },
            output: {
              type: 'object',
              properties: { path: { type: 'string', description: 'An .mp4 under the renders folder; default renders/preview.mp4.' } },
            },
          },
          required: ['canvas', 'sources', 'clips'],
        },
      },
      required: ['manifest'],
    },
  },
];
