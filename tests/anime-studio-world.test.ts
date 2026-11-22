import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { ToolCallContext } from 'cortico/core/types.ts';
import {
  AnimeStudioWorld,
  DEFAULT_ANIME_STUDIO_COMMAND,
  DEFAULT_ANIME_STUDIO_SCRIPT,
  DEFAULT_COMFYUI_URL,
} from '../core/anime-studio/world.ts';

const hasLocalStudio = existsSync(DEFAULT_ANIME_STUDIO_COMMAND) && existsSync(DEFAULT_ANIME_STUDIO_SCRIPT);

describe('AnimeStudioWorld (local ComfyUI MCP bridge)', () => {
  it('exposes the 4 async-safe tools and envPrompt declaration', () => {
    const world = new AnimeStudioWorld({
      modelLanguage: () => 'zh',
      command: () => DEFAULT_ANIME_STUDIO_COMMAND,
      scriptPath: () => DEFAULT_ANIME_STUDIO_SCRIPT,
      comfyuiUrl: () => DEFAULT_COMFYUI_URL,
    });
    expect(world.id).toBe('anime-studio');
    expect(world.tools().map((t) => t.name)).toEqual([
      'anime_studio_assets',
      'anime_studio_submit',
      'anime_studio_job',
      'anime_studio_jobs',
    ]);
    const ui = world.webUi();
    expect(ui.promptDocs?.length).toBe(1);
    expect(ui.promptDocs?.[0]?.key).toBe('worlds.anime-studio.envPrompt');
    expect(world.envPromptVars()).toEqual({ comfyuiUrl: DEFAULT_COMFYUI_URL });
  });

  it.skipIf(!hasLocalStudio)('connects to local mcp_server.py over stdio and reads assets + jobs', async () => {
    const world = new AnimeStudioWorld({
      modelLanguage: () => 'zh',
      command: () => DEFAULT_ANIME_STUDIO_COMMAND,
      scriptPath: () => DEFAULT_ANIME_STUDIO_SCRIPT,
      comfyuiUrl: () => DEFAULT_COMFYUI_URL,
      timeoutMs: () => 20_000,
    });
    const byName = new Map(world.tools().map((t) => [t.name, t]));
    const ctx = { role: 'main', log: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {}, child() { return this; } } } as unknown as ToolCallContext;
    try {
      const assetsOutcome = await byName.get('anime_studio_assets')!.handler({}, ctx);
      expect(typeof assetsOutcome).toBe('object');
      const assetsText = (assetsOutcome as { text: string; failed?: boolean }).text;
      expect((assetsOutcome as { failed?: boolean }).failed).not.toBe(true);
      const parsed = JSON.parse(assetsText);
      expect(parsed.styles).toHaveProperty('EDITORIAL_HIGHKEY');
      expect(parsed.styles).toHaveProperty('ILLUSTRATION_MASTER');
      expect(parsed.async_actions).toContain('generate_fast_dual_engine');

      const jobsOutcome = await byName.get('anime_studio_jobs')!.handler({ limit: 3 }, ctx);
      expect((jobsOutcome as { failed?: boolean }).failed).not.toBe(true);
    } finally {
      await world.stop();
    }
  }, 25_000);
});
