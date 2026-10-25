import { withWorldPanel } from './panel-runtime.ts'
import { PANEL_GUIDE } from './panel-guide.ts'
/** 好感度 World 的定义。挂载后提供三个工具：查交情、记一笔、看排行。 */
import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { AFFINITY_DEFAULTS, AFFINITY_CONFIG_GROUP, type AffinityConfigSection } from './config.ts';
import { AffinityWorld, affinityToolDecls } from './world.ts';

export interface AffinityDeps {
  dataDir: string;
  timezone: string;
  /** 部署目录。用来读 QQ World 落的进群流水（`<botDir>/data/group-entry.jsonl`）。 */
  botDir: string;
}

export function createAffinityWorld(cfg: AffinityConfigSection, deps: AffinityDeps): AffinityWorld {
  return new AffinityWorld({ cfg, dataDir: deps.dataDir, timezone: deps.timezone, botDir: deps.botDir });
}

export const AFFINITY: WorldDefinition<AffinityConfigSection> = withWorldPanel({
  id: 'affinity',
  label: '好感度',
  defaults: () => ({ ...AFFINITY_DEFAULTS }),
  create: (ctx) => createAffinityWorld(ctx.cfg, {
    dataDir: ctx.dataDir,
    timezone: ctx.timezone,
    botDir: ctx.botDir,
  }),
  describe: {
    tools: describeTools(affinityToolDecls(), {
      affinity_get: { zh: '查你此刻对他的感觉、关系和还没过去的事。', en: 'Reads how you feel about the person right now, the relationship, and what is still unresolved.' },
      affinity_adjust: { zh: '记一笔亲疏的变化,或者只记一股情绪。', en: 'Records a change in closeness, or just a feeling.' },
      affinity_feel: { zh: '记一股情绪：多强、为什么、碰到哪条需要、要不要说出来。', en: 'Records a feeling: how strong, why, which need it touched, and whether to show it.' },
      affinity_repair: { zh: '记一次修复：他做了什么、你接不接受、这件事过去没有。', en: 'Records a repair: what the person did, whether it helped, and whether the thing is over.' },
      affinity_slot: { zh: '给某个人定「关系格子」——他算你的什么人。', en: 'Sets what someone is to you.' },
      affinity_list: { zh: '看心里排前面的几个人。', en: 'Lists the people closest to you.' },
    }),
    events: [
      {
        type: 'affinity.started',
        description: { zh: '好感度 World 挂载后开始工作。', en: 'The affinity World started working.' },
      },
      {
        type: 'affinity.changed',
        description: { zh: '亲疏、关系格子、情绪或还没过去的事发生变化。', en: 'The closeness, relationship slot, a feeling, or something unresolved changed.' },
      },
    ],
  },
}, PANEL_GUIDE);

export type { AffinityWorld, ToolDef, World, WorldWebUiDecl, WorldHost };
export { AFFINITY_CONFIG_GROUP };
