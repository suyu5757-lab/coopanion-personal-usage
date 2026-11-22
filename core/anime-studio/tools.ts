/**
 * Model-visible tool declarations for the bundled Anime Studio (local ComfyUI MCP) World.
 * Only async job-queue and fast query tools are exposed so long Apple M2 renders never time out.
 */
import type { ToolDef } from 'cortico/core/types.ts';

export type AnimeStudioToolDecl = Omit<ToolDef, 'handler'>;

export const ANIME_STUDIO_TOOL_DECLS: readonly AnimeStudioToolDecl[] = [
  {
    name: 'anime_studio_assets',
    tags: ['read'],
    description:
      'Query local ComfyUI Anime Studio v5.1 status (online/version/device), the 5 style presets ' +
      '(EDITORIAL_HIGHKEY, ILLUSTRATION_MASTER, ANIME_CINEMATIC, CLEAN_ANIME, CINEMATIC_ILLUSTRATION), ' +
      'resolutions, characters, sampler defaults, and supported async actions. Call before submitting jobs.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'anime_studio_submit',
    tags: ['act'],
    description:
      'Submit an asynchronous local ComfyUI Anime Studio render job (<1s return with job_id) to avoid tool timeouts. ' +
      'Read workspace/skills/anime-studio-sop.md first for style routing, 3D framing rules, and SceneSpec templates. ' +
      'Supported actions: generate_drafts, generate_fast_dual_engine, generate_dual_engine_draft, refine_image, ' +
      'upscale_4k_optional, apply_poster_overlay.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'generate_drafts',
            'generate_fast_dual_engine',
            'generate_dual_engine_draft',
            'refine_image',
            'upscale_4k_optional',
            'apply_poster_overlay',
          ],
          description: 'Async Anime Studio pipeline action to run on local ComfyUI.',
        },
        params: {
          type: 'object',
          description: 'Action parameter object matching the Anime Studio MCP specification (e.g., scene_spec, natural_prompt, count, draft_path, image_path, title, signature).',
        },
      },
      required: ['action', 'params'],
    },
  },
  {
    name: 'anime_studio_job',
    tags: ['read'],
    description:
      'Check status (running/completed/failed), elapsed_s, error, and output image file paths for a previously submitted Anime Studio job_id.',
    parameters: {
      type: 'object',
      properties: {
        job_id: {
          type: 'string',
          description: 'The job_id returned by anime_studio_submit.',
        },
      },
      required: ['job_id'],
    },
  },
  {
    name: 'anime_studio_jobs',
    tags: ['read'],
    description: 'List recent local ComfyUI Anime Studio async jobs with status, action, elapsed_s, and started_at.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of recent jobs to return (1-30, default 10).',
        },
      },
    },
  },
];
