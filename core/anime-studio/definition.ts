/**
 * Definition and configuration schema for the bundled Anime Studio (local ComfyUI MCP) World.
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import { describeTools, type WorldDefinition, type WorldSection } from 'cortico/world.ts';
import type { ModelLanguage } from '../language.ts';
import { ANIME_STUDIO_TOOL_DECLS } from './tools.ts';
import {
  ANIME_STUDIO_WORLD_ID,
  AnimeStudioWorld,
  DEFAULT_ANIME_STUDIO_COMMAND,
  DEFAULT_ANIME_STUDIO_SCRIPT,
  DEFAULT_ANIME_STUDIO_TIMEOUT_MS,
  DEFAULT_COMFYUI_URL,
} from './world.ts';

export const ANIME_STUDIO_ID = ANIME_STUDIO_WORLD_ID;
const ANIME_STUDIO_CONFIG = 'worlds.anime-studio';

export function animeStudioConfigGroup(language: Language = 'zh'): ConfigGroup {
  const zh = language === 'zh' || language === 'zh-Hant';
  return {
    id: 'world:anime-studio',
    owner: 'world:anime-studio',
    schema: {
      type: 'object',
      title: zh ? '本地 ComfyUI 生图（Anime Studio）' : 'Local ComfyUI (Anime Studio)',
      properties: {
        [`${ANIME_STUDIO_CONFIG}.command`]: {
          type: 'string',
          title: zh ? 'Python 解释器路径' : 'Python executable',
          description: zh ? '用于运行 Anime Studio MCP Server 的 Python 虚拟环境路径。' : 'Python binary inside the ComfyUI virtual environment.',
          'x-hot': true,
        },
        [`${ANIME_STUDIO_CONFIG}.scriptPath`]: {
          type: 'string',
          title: zh ? 'MCP Server 脚本路径' : 'MCP Server script path',
          description: zh ? 'Anime Studio mcp_server.py 的绝对路径。' : 'Absolute path to Anime Studio mcp_server.py.',
          'x-hot': true,
        },
        [`${ANIME_STUDIO_CONFIG}.comfyuiUrl`]: {
          type: 'string',
          title: zh ? 'ComfyUI 地址' : 'ComfyUI URL',
          description: zh ? '本机 ComfyUI API 地址，默认 http://127.0.0.1:8188。' : 'Local ComfyUI HTTP endpoint.',
          'x-hot': true,
        },
      },
    },
  };
}

export interface AnimeStudioAssembly {
  modelLanguage: () => ModelLanguage;
  language?: () => Language;
  command?: () => string;
  scriptPath?: () => string;
  comfyuiUrl?: () => string;
  timeoutMs?: () => number;
}

const SUMMARIES = {
  anime_studio_assets: {
    zh: '查询本机 ComfyUI 服务状态、5 档画风预设、画幅、角色与可用异步生图动作。',
    en: 'Queries local ComfyUI status, 5 style presets, resolutions, characters, and async actions.',
  },
  anime_studio_submit: {
    zh: '异步提交本地 ComfyUI 生图/精修/4K放大/海报排版任务，1 秒内返回 job_id 防超时。',
    en: 'Submits an async local ComfyUI render/refine/4K/poster job and returns job_id immediately.',
  },
  anime_studio_job: {
    zh: '查询异步生图任务的状态、耗时与最终产物文件路径。',
    en: 'Checks status, elapsed time, and output image paths for an async Anime Studio job.',
  },
  anime_studio_jobs: {
    zh: '列出最近提交的本地 ComfyUI 异步生图任务摘要。',
    en: 'Lists recent local ComfyUI Anime Studio async jobs.',
  },
} as const;

export function animeStudioDefinition(assembly: AnimeStudioAssembly): WorldDefinition<WorldSection> {
  return {
    id: ANIME_STUDIO_ID,
    get label() {
      const language = assembly.language?.();
      return language === 'zh' || language === 'zh-Hant' ? '本地 ComfyUI（Anime Studio）' : 'Anime Studio (ComfyUI)';
    },
    defaults: () => ({
      enabled: true,
      command: DEFAULT_ANIME_STUDIO_COMMAND,
      scriptPath: DEFAULT_ANIME_STUDIO_SCRIPT,
      comfyuiUrl: DEFAULT_COMFYUI_URL,
      timeoutMs: DEFAULT_ANIME_STUDIO_TIMEOUT_MS,
    }),
    create: (ctx) => {
      const cfg = ctx.cfg as unknown as {
        command?: string;
        scriptPath?: string;
        comfyuiUrl?: string;
        timeoutMs?: number;
      };
      return new AnimeStudioWorld({
        modelLanguage: assembly.modelLanguage,
        command: () => assembly.command?.() || cfg.command || DEFAULT_ANIME_STUDIO_COMMAND,
        scriptPath: () => assembly.scriptPath?.() || cfg.scriptPath || DEFAULT_ANIME_STUDIO_SCRIPT,
        comfyuiUrl: () => assembly.comfyuiUrl?.() || cfg.comfyuiUrl || DEFAULT_COMFYUI_URL,
        timeoutMs: () => assembly.timeoutMs?.() || cfg.timeoutMs || DEFAULT_ANIME_STUDIO_TIMEOUT_MS,
      });
    },
    describe: {
      tools: describeTools(ANIME_STUDIO_TOOL_DECLS, SUMMARIES),
      events: [],
    },
  };
}
