/**
 * Native Coopanion World bridging to the local ComfyUI Anime Studio v5.1 MCP server over stdio.
 * Exposes the 4 non-blocking tools (`anime_studio_assets`, `anime_studio_submit`,
 * `anime_studio_job`, `anime_studio_jobs`) while routing execution to `mcp_server.py`.
 */
import { fileURLToPath } from 'node:url';
import type { ToolCallContext, ToolDef, ToolOutcome, World, WorldEnvPromptVars, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { ModelLanguage } from '../language.ts';
import { McpStdioClient } from './stdio-client.ts';
import { ANIME_STUDIO_TOOL_DECLS } from './tools.ts';

export const ANIME_STUDIO_WORLD_ID = 'anime-studio';

export const DEFAULT_ANIME_STUDIO_COMMAND = '/Users/yusu/AI_Art/ComfyUI/.venv/bin/python';
export const DEFAULT_ANIME_STUDIO_SCRIPT = '/Users/yusu/AI_Art/anime_studio/mcp_server.py';
export const DEFAULT_COMFYUI_URL = 'http://127.0.0.1:8188';
export const DEFAULT_ANIME_STUDIO_TIMEOUT_MS = 60_000;

const ENV_PROMPT_FILES: Record<ModelLanguage, string> = {
  zh: fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url)),
  en: fileURLToPath(new URL('./ENV_PROMPT.en.md', import.meta.url)),
};

export interface AnimeStudioWorldOptions {
  modelLanguage: () => ModelLanguage;
  command: () => string;
  scriptPath: () => string;
  comfyuiUrl: () => string;
  timeoutMs?: () => number;
}

export class AnimeStudioWorld implements World {
  readonly id = ANIME_STUDIO_WORLD_ID;
  private readonly client: McpStdioClient;

  constructor(private readonly opts: AnimeStudioWorldOptions) {
    this.client = new McpStdioClient(() => {
      const command = this.opts.command().trim() || DEFAULT_ANIME_STUDIO_COMMAND;
      const scriptPath = this.opts.scriptPath().trim() || DEFAULT_ANIME_STUDIO_SCRIPT;
      const comfyuiUrl = this.opts.comfyuiUrl().trim() || DEFAULT_COMFYUI_URL;
      const timeoutMs = this.opts.timeoutMs?.() || DEFAULT_ANIME_STUDIO_TIMEOUT_MS;
      return {
        command,
        args: [scriptPath],
        env: { COMFYUI_URL: comfyuiUrl },
        timeoutMs,
      };
    });
  }

  webUi(): WorldWebUiDecl {
    const en = this.opts.modelLanguage() === 'en';
    return {
      label: en ? 'Anime Studio' : '本地 ComfyUI 生图',
      promptDocs: [{
        key: 'worlds.anime-studio.envPrompt',
        title: en ? 'Anime Studio (ComfyUI) environment' : '本地 ComfyUI 生图环境',
        description: en
          ? 'Describes the local ComfyUI Anime Studio v5.1 MCP bridge and async workflow.'
          : '描述本机 ComfyUI Anime Studio v5.1 MCP 生图工具与异步防超时流程。',
        path: ENV_PROMPT_FILES[this.opts.modelLanguage()],
        role: 'envPrompt',
        vars: [
          { name: 'comfyuiUrl', description: en ? 'Local ComfyUI HTTP endpoint.' : '本机 ComfyUI HTTP 地址。' },
        ],
      }],
    };
  }

  envPromptVars(): WorldEnvPromptVars {
    return {
      comfyuiUrl: this.opts.comfyuiUrl().trim() || DEFAULT_COMFYUI_URL,
    };
  }

  async start(): Promise<void> {
    // Lazy stdio spawn on first tool call so Coopanion startup stays instantaneous.
  }

  async stop(): Promise<void> {
    await this.client.close();
  }

  tools(): ToolDef[] {
    return ANIME_STUDIO_TOOL_DECLS.map((decl) => ({
      ...decl,
      handler: (args, ctx) => this.run(decl.name, args, ctx),
    }));
  }

  private async run(tool: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolOutcome> {
    if (ctx.signal?.aborted) {
      return { text: '[anime-studio] aborted', failed: true };
    }
    try {
      if (tool === 'anime_studio_assets') {
        const res = await this.client.callTool('list_studio_assets', {});
        return res.isError ? { text: res.text, failed: true } : { text: res.text };
      }
      if (tool === 'anime_studio_submit') {
        const action = typeof args.action === 'string' ? args.action.trim() : '';
        const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : {};
        if (!action) {
          return { text: '[anime-studio] missing required parameter: action', failed: true };
        }
        const res = await this.client.callTool('submit_studio_job', { action, params });
        return res.isError ? { text: res.text, failed: true } : { text: res.text };
      }
      if (tool === 'anime_studio_job') {
        const jobId = typeof args.job_id === 'string' ? args.job_id.trim() : '';
        if (!jobId) {
          return { text: '[anime-studio] missing required parameter: job_id', failed: true };
        }
        const res = await this.client.callTool('get_studio_job', { job_id: jobId });
        return res.isError ? { text: res.text, failed: true } : { text: res.text };
      }
      if (tool === 'anime_studio_jobs') {
        const limitRaw = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.floor(args.limit) : 10;
        const limit = Math.max(1, Math.min(30, limitRaw));
        const res = await this.client.callTool('list_studio_jobs', { limit });
        return res.isError ? { text: res.text, failed: true } : { text: res.text };
      }
      return { text: `[anime-studio] unknown tool: ${tool}`, failed: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { text: `[anime-studio] MCP call failed: ${msg}`, failed: true };
    }
  }
}
