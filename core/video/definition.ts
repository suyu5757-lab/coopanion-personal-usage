/**
 * The video World's definition for Coopanion: the tool list, the section defaults. No panel; the
 * person puts source files in the media folder by hand and Coo names the rendered file in the
 * receipt. `COOPANION_FFMPEG` overrides the binary found on PATH.
 */
import type { Language } from 'cortico/core/language.ts';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import { describeTools, type WorldDefinition, type WorldSection } from 'cortico/world.ts';
import type { ModelLanguage } from '../language.ts';
import { VIDEO_TOOL_DECLS } from './tools.ts';
import { VideoWorld, VIDEO_WORLD_ID } from './world.ts';

export const VIDEO_ID = VIDEO_WORLD_ID;
const VIDEO_CONFIG = 'worlds.video';

const CONFIG_TEXT: Record<Language, { group: string; ffmpeg: string; ffmpegHelp: string; ffprobe: string; ffprobeHelp: string }> = {
  zh: { group: '视频', ffmpeg: 'FFmpeg 路径', ffmpegHelp: '留空时按环境变量、常见安装目录和 PATH 查找。', ffprobe: 'ffprobe 路径', ffprobeHelp: '留空时查找与 FFmpeg 配套的 ffprobe。' },
  'zh-Hant': { group: '影片', ffmpeg: 'FFmpeg 路徑', ffmpegHelp: '留空時依環境變數、常見安裝目錄和 PATH 尋找。', ffprobe: 'ffprobe 路徑', ffprobeHelp: '留空時尋找與 FFmpeg 配套的 ffprobe。' },
  en: { group: 'Video', ffmpeg: 'FFmpeg path', ffmpegHelp: 'Leave empty to search environment settings, common install locations and PATH.', ffprobe: 'ffprobe path', ffprobeHelp: 'Leave empty to find ffprobe beside FFmpeg or on PATH.' },
  ja: { group: '動画', ffmpeg: 'FFmpeg のパス', ffmpegHelp: '空欄の場合、環境変数、一般的なインストール先、PATH の順に探します。', ffprobe: 'ffprobe のパス', ffprobeHelp: '空欄の場合、FFmpeg と同じ場所または PATH から探します。' },
  ko: { group: '비디오', ffmpeg: 'FFmpeg 경로', ffmpegHelp: '비워 두면 환경 변수, 일반 설치 위치, PATH 순서로 찾습니다.', ffprobe: 'ffprobe 경로', ffprobeHelp: '비워 두면 FFmpeg와 같은 위치 또는 PATH에서 찾습니다.' },
  fr: { group: 'Vidéo', ffmpeg: 'Chemin FFmpeg', ffmpegHelp: 'Vide, le chemin est recherché dans les variables d’environnement, les emplacements courants puis PATH.', ffprobe: 'Chemin ffprobe', ffprobeHelp: 'Vide, ffprobe est recherché à côté de FFmpeg ou dans PATH.' },
  de: { group: 'Video', ffmpeg: 'FFmpeg-Pfad', ffmpegHelp: 'Leer: Suche über Umgebungsvariablen, übliche Installationsorte und PATH.', ffprobe: 'ffprobe-Pfad', ffprobeHelp: 'Leer: Suche neben FFmpeg oder in PATH.' },
  'es-419': { group: 'Video', ffmpeg: 'Ruta de FFmpeg', ffmpegHelp: 'Déjala vacía para buscar en variables de entorno, ubicaciones comunes y PATH.', ffprobe: 'Ruta de ffprobe', ffprobeHelp: 'Déjala vacía para buscar junto a FFmpeg o en PATH.' },
  'pt-BR': { group: 'Vídeo', ffmpeg: 'Caminho do FFmpeg', ffmpegHelp: 'Deixe vazio para buscar nas variáveis de ambiente, locais comuns e PATH.', ffprobe: 'Caminho do ffprobe', ffprobeHelp: 'Deixe vazio para buscar ao lado do FFmpeg ou no PATH.' },
  it: { group: 'Video', ffmpeg: 'Percorso FFmpeg', ffmpegHelp: 'Vuoto: cerca nelle variabili d’ambiente, nelle posizioni comuni e nel PATH.', ffprobe: 'Percorso ffprobe', ffprobeHelp: 'Vuoto: cerca accanto a FFmpeg o nel PATH.' },
  ru: { group: 'Видео', ffmpeg: 'Путь к FFmpeg', ffmpegHelp: 'Пустое поле: поиск в переменных среды, стандартных каталогах и PATH.', ffprobe: 'Путь к ffprobe', ffprobeHelp: 'Пустое поле: поиск рядом с FFmpeg или в PATH.' },
};

export function videoConfigGroup(language: Language = 'zh'): ConfigGroup {
  const text = CONFIG_TEXT[language];
  return {
    id: 'world:video',
    owner: 'world:video',
    schema: {
      type: 'object',
      title: text.group,
      properties: {
        [`${VIDEO_CONFIG}.ffmpegPath`]: { type: 'string', title: text.ffmpeg, description: text.ffmpegHelp, 'x-path': { kind: 'file' }, 'x-hot': true },
        [`${VIDEO_CONFIG}.ffprobePath`]: { type: 'string', title: text.ffprobe, description: text.ffprobeHelp, 'x-path': { kind: 'file' }, 'x-hot': true },
      },
    },
  };
}

export interface VideoAssembly {
  modelLanguage: () => ModelLanguage;
  language?: () => Language;
  ffmpegPath?: () => string;
  ffprobePath?: () => string;
}

const SUMMARIES = {
  video_list_media: {
    zh: '列出视频素材目录中的图片、视频和音频文件。',
    en: 'Lists images, videos and audio files in the media folder.',
  },
  video_render: {
    zh: '按编辑清单把授权素材剪成一段竖屏预览 MP4,并检查分辨率、时长、编码和黑屏。',
    en: 'Renders an authorized edit manifest into a vertical preview MP4 and checks its size, duration, codecs and black stretches.',
  },
} as const;

export function videoDefinition(assembly: VideoAssembly): WorldDefinition<WorldSection> {
  return {
    id: VIDEO_ID,
    get label() {
      const language = assembly.language?.();
      return language === 'zh' || language === 'zh-Hant' ? '视频' : 'Video';
    },
    defaults: () => ({ enabled: false, ffmpegPath: '', ffprobePath: '' }),
    create: (ctx) => {
      const cfg = ctx.cfg as unknown as { ffmpegPath?: string; ffprobePath?: string };
      return new VideoWorld({
        dataDir: ctx.dataDir,
        modelLanguage: assembly.modelLanguage,
        ffmpegPath: () => assembly.ffmpegPath?.() ?? cfg.ffmpegPath ?? '',
        ffprobePath: () => assembly.ffprobePath?.() ?? cfg.ffprobePath ?? '',
      });
    },
    describe: {
      tools: describeTools(VIDEO_TOOL_DECLS, SUMMARIES),
      events: [],
    },
  };
}
