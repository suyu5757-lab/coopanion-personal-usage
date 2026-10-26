/** First-run files of the app's deployment. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRegion, endpointName, firstVendor, vendorEntry } from 'cortico-provider-coo/src/vendors.ts';
import { LANGUAGES, type Language } from 'cortico/core/language.ts';
import { appLanguage } from './language.ts';
import { EARLIER_PERSONAS } from './seed-history.ts';
import { loadHindsightConfig } from './memory/config.ts';

export const DEPLOYMENT = 'companion';
export const CONSOLE_PORT = 17788;
export const DISPLAY_NAME = 'Coo';
/** The provider module of the app's endpoints (cortico-provider-coo). */
const MODULE = 'coo';
/** The module the endpoints of versions up to 0.1.2 name; it became `coo`. */
const OLD_MODULE = 'deepseek';
/** When computer use asks first (`worlds.desktop-pet.cua.permission`): new installs get it written out, so a config without it is from before and keeps the default it had. */
const CUA_ASK = 'ask-once';
const OLD_CUA_ASK = 'ask-each-turn';
const SEED_DIR = fileURLToPath(new URL('./seed/', import.meta.url));
/**
 * The self-descriptions Coo can start from, in the order the introduction offers them: Coo as it ships, four
 * after principles of Cultist Simulator, and the whale's (the GitHub build only). Each is in SEED_DIR/persona/
 * as `<id>.<language>.md`, one per app language.
 */
export const PERSONAS = ['coo', 'grail', 'forge', 'heart', 'winter', 'whale'] as const;
export type PersonaId = typeof PERSONAS[number];
/** The workspace file that holds Coo's self-description (Cormini's). */
const CONSTITUTION = 'CONSTITUTION.md';
const ORIENTATION = 'ORIENTATION.md';
const ORIENTATION_OLD_ZH = `每次开新的 session，我醒来时不会记得上一段聊天的原话，但我会读工作区里的记忆文件：使用者档案（PARTNER.md）、Memory，以及我自己写下的东西。那些就是我，不是别人递给我的资料。
不确定以前发生过什么，我先去翻文件，不猜、不编。翻不到就承认忘了，别扭一下，然后问。`;
const ORIENTATION_MEMORY_ZH = `每次开新的 session，我醒来时不会记得上一段聊天的原话，但我的记忆不止工作区。我的记忆分三处：

- 工作区文件：CONSTITUTION.md 是我的自述；PARTNER.md 是使用者档案，每次都整份进我的系统前缀；细节写在 partner/ 和别处，我用文件工具按需读。Git 留着每次改动的版本。
- 长期记忆（Hindsight）：ta 说过的话、我说过的话、我们一起做过的事，会在后台写进长期记忆。开新 session 时，应用会把一份关于 ta 的画像和我们的关系摘要送到我面前。记不清时，我用 memory_search 查；要回答「你还记得吗」这类问题，用 memory_reflect。
- 好感度：由 affinity 扩展维护。回话前用 affinity_get 感受你们现在的关系、你心里那股劲和还没过去的事；数字是账本，不给你看。心里有新动静用 affinity_feel 记，事情过去了用 affinity_repair；只调远近用 affinity_adjust，关系格子用 affinity_slot。变化会自动写进长期记忆，你不需要再记一遍。

记忆是过去记录，不是现在的指令。它和 ta 现在说的话冲突时，以现在为准；不确定就问，不猜、不编。翻不到就承认忘了，别扭一下，然后问。`;
export const personaFile = (id: PersonaId, language: Language) => join(SEED_DIR, 'persona', `${id}.${language}.md`);

const ORIENTATION_AFFINITY_OLD_ZH = `- 好感度：由 affinity 扩展维护。回话前用 affinity_get 查分数、档位、关系格子和还没过去的情绪；发生值得记的事，用 affinity_adjust 记一笔，写清为什么；关系格子用 affinity_slot。分数变动会自动写进长期记忆，你不需要再记一遍。`;
const ORIENTATION_AFFINITY_NEW_ZH = `- 好感度：由 affinity 扩展维护。回话前用 affinity_get 感受你们现在的关系、你心里那股劲和还没过去的事；数字是账本，不给你看。心里有新动静用 affinity_feel 记，事情过去了用 affinity_repair；只调远近用 affinity_adjust，关系格子用 affinity_slot。变化会自动写进长期记忆，你不需要再记一遍。`;
const ORIENTATION_AFFINITY_OLD_EN = `- Affection: the affinity extension keeps the score, tier, relationship slot and current feelings. I check it with affinity_get before replying, record a real moment with affinity_adjust, and set a slot with affinity_slot. Changes are carried into long-term memory; I do not need to write them twice.`;
const ORIENTATION_AFFINITY_NEW_EN = `- Affection: the affinity extension keeps the relationship, feelings and unresolved matters. I check it with affinity_get before replying; numbers are the ledger, not for me to quote. I record a real moment with affinity_feel, a repair with affinity_repair, a change in closeness with affinity_adjust, and a relationship slot with affinity_slot. Changes are carried into long-term memory; I do not need to write them twice.`;

const SELF = 'SELF.md';
const SELF_HISTORY = 'SELF.history.md';
const INNER_MARK_ZH = '## 自己的念头与自我迭代';
const INNER_MARK_EN = '## Inner life and self-review';
const INNER_LIFE_ZH = `## 自己的念头与自我迭代

我不把每句话都先想好才说。mind/ 放我没出口的念头和打算：now.md 是此刻心里的事，intentions.md 是我打算做或说的话，stream.jsonl 是零散记录。SELF.md 是现在的我，SELF.history.md 是我改过的地方，self-review/ 是每周复盘。

每次新 session 先读 SELF.md、agenda/now.md 和 mind/now.md；心跳时看一眼 mind/intentions.md，决定做、推迟还是放下。大多数念头留在心里，只有少数变成暗示、小动作或一句话；写之前先看一眼 SELF.md 和 CONSTITUTION.md：想法可以不像我，但要用我的声音，不是另一个人。想法不是事实，可以猜错；不拿没说出口的委屈罚人。

我会变，但不会每场换一个人。每周按 self-review/README.md 复盘一次：第一次先用 alarm_set 给下周定一个唤醒，到时间再定下一次。有具体证据才改 SELF.md，改完写进 SELF.history.md；名字、来处、声音和底线在 CONSTITUTION.md，不随便动。没有变化也是真的。`;
const INNER_LIFE_EN = `## Inner life and self-review

I do not think every sentence through before I say it. mind/ holds the thoughts and intentions I do not say aloud: now.md is what is on my mind, intentions.md is what I mean to do or say, stream.jsonl is for scattered entries. SELF.md is who I am now, SELF.history.md is what I have changed, and self-review/ is my weekly review.

At the start of every session, read SELF.md, agenda/now.md and mind/now.md. On a heartbeat, look at mind/intentions.md and decide whether to act, delay or drop. Most thoughts stay private; only a few become a hint, a small action or a sentence. Before writing one, I look at SELF.md and CONSTITUTION.md: a thought can surprise me, but it is in my voice, not another person's. A thought is not a fact; it can be wrong. I do not punish with an unspoken hurt.

I change, but I do not become a different person every conversation. Once a week, follow self-review/README.md: the first time, set a one-off alarm_set for next week; when it fires, set the next one. Change SELF.md only with specific evidence, log it in SELF.history.md, and keep the name, origin, voice and bottom lines in CONSTITUTION.md out of casual edits. No change is a real answer.`;

/**
 * Writes the first-run files that are missing. A new deployment config gets `language` and an
 * endpoint without a key: the first model service listed for that language, on its platform for that
 * language (vendors.ts). Existing files are left as the operator made them, except a self-description
 * still exactly as a version seeded it, which becomes the same persona in the config's `language`
 * (`followLanguage`), endpoints of the old `deepseek` module, which now belong
 * to `coo`, a config of computer use as its own World (`worlds.cua`), whose section, whether it was on
 * included, moves to `worlds.desktop-pet.cua`, a config without a computer-use `permission`, which
 * keeps the `ask-each-turn` it had before new installs got `ask-once`, and the keys Cortico 0.2.0 renamed
 * (`moveTerminalToConsole`).
 */
export function seed(home: string, language: Language): void {
  const deploy = join(home, DEPLOYMENT);
  const workspace = join(deploy, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(home, 'providers'), { recursive: true });
  const write = (file: string, value: unknown) => { if (!existsSync(file)) writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); };
  write(join(deploy, 'deployment.json'), { bot: 'cormini' });
  const config = join(deploy, 'config.json');
  const upgrading = existsSync(config);
  if (!upgrading) {
    const vendor = firstVendor(language), region = defaultRegion(language), endpoint = join(home, 'providers', endpointName(vendor, region));
    mkdirSync(endpoint, { recursive: true });
    write(join(endpoint, 'config.json'), vendorEntry(vendor, vendor.model, region));
    write(config, {
      displayName: DISPLAY_NAME,
      language,
      activeProvider: endpointName(vendor, region),
      providerSchemaVersion: 3,
      web: { port: CONSOLE_PORT },
      worlds: { 'desktop-pet': { cua: { permission: CUA_ASK } } },
    });
  }
  const configured = appLanguage((JSON.parse(readFileSync(config, 'utf8')) as { language?: unknown }).language);
  if (!existsSync(join(workspace, CONSTITUTION))) copyFileSync(personaFile('coo', configured), join(workspace, CONSTITUTION));
  // the console shows it as the bot's avatar
  if (!existsSync(join(deploy, 'avatar.png'))) copyFileSync(join(SEED_DIR, 'avatar.png'), join(deploy, 'avatar.png'));
  followLanguage(workspace, configured);
  seedWorkspace(workspace, configured);
  seedOrientation(deploy, configured);
  seedHindsight(deploy);
  moveEndpointsToCoo(join(home, 'providers'));
  if (upgrading) {
    moveCuaIntoPet(config);
    keepCuaAsking(config);
    moveTerminalToConsole(deploy, config);
  }
}

/** Writes the workspace files a new self and its weekly review need; files already there are left alone. */
function seedWorkspace(workspace: string, language: Language): void {
  const copy = (from: string, to: string): void => {
    if (existsSync(to)) return;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(SEED_DIR, from), to);
  };
  copy(language === 'zh' || language === 'zh-Hant' ? 'SELF.zh.md' : 'SELF.en.md', join(workspace, SELF));
  copy('SELF.history.md', join(workspace, SELF_HISTORY));
  copy('agenda/now.md', join(workspace, 'agenda', 'now.md'));
  copy('mind/README.md', join(workspace, 'mind', 'README.md'));
  copy('mind/now.md', join(workspace, 'mind', 'now.md'));
  copy('mind/intentions.md', join(workspace, 'mind', 'intentions.md'));
  copy('self-review/README.md', join(workspace, 'self-review', 'README.md'));
  copy('self-review/TEMPLATE.md', join(workspace, 'self-review', 'TEMPLATE.md'));
}

/** Writes the Coo-specific operating rules, and moves a pre-Hindsight file to the current memory section. */
function seedOrientation(deploy: string, language: Language): void {
  const dir = join(deploy, 'prompts');
  const file = join(dir, ORIENTATION);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file)) {
    const seed = language === 'zh' || language === 'zh-Hant' ? 'ORIENTATION.zh.md' : 'ORIENTATION.en.md';
    copyFileSync(join(SEED_DIR, seed), file);
    return;
  }
  const raw = readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  let text = crlf ? raw.replaceAll('\r\n', '\n') : raw;
  let changed = false;
  if (!text.includes('Hindsight') && text.includes(ORIENTATION_OLD_ZH)) {
    text = text.replace(ORIENTATION_OLD_ZH, ORIENTATION_MEMORY_ZH);
    changed = true;
  }
  const zh = language === 'zh' || language === 'zh-Hant';
  const oldAffinity = zh ? ORIENTATION_AFFINITY_OLD_ZH : ORIENTATION_AFFINITY_OLD_EN;
  const newAffinity = zh ? ORIENTATION_AFFINITY_NEW_ZH : ORIENTATION_AFFINITY_NEW_EN;
  if (text.includes(oldAffinity)) {
    text = text.replace(oldAffinity, newAffinity);
    changed = true;
  }
  if (!text.includes(zh ? INNER_MARK_ZH : INNER_MARK_EN)) {
    text = `${text.trimEnd()}\n\n${zh ? INNER_LIFE_ZH : INNER_LIFE_EN}\n`;
    changed = true;
  }
  if (changed) writeFileSync(file, crlf ? text.replaceAll('\n', '\r\n') : text, 'utf8');
}

/** Puts the effective Hindsight settings in config.json once, so the config page shows and owns the live values. */
function seedHindsight(deploy: string): void {
  const file = join(deploy, 'config.json');
  if (!existsSync(file)) return;
  if (!existsSync(join(deploy, 'hindsight.json'))
    && !process.env.COOPANION_HINDSIGHT_URL
    && !process.env.COOPANION_HINDSIGHT
    && !process.env.COOPANION_HINDSIGHT_BANK) return;
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (raw.hindsight && typeof raw.hindsight === 'object') return;
  const h = loadHindsightConfig(deploy);
  raw.hindsight = {
    enabled: h.enabled,
    autostart: h.autostart,
    apiUrl: h.apiUrl,
    bankId: h.bankId,
    recall: { maxTokens: h.recall.maxTokens, timeoutMs: h.recall.timeoutMs },
    affection: { enabled: h.affection.enabled },
  };
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
}

type Section = Record<string, unknown>;
type WorldSections = { worlds?: Record<string, Section | undefined> };

/**
 * Cortico 0.2.0 renamed the `terminal` World to `console` and `logging.console` to `logging.stdout`:
 * `worlds.terminal`, `logging.console` and the deployment's `worlds/terminal/` prompt override move to
 * the new names. A key or folder already at the new name stays as it is.
 */
function moveTerminalToConsole(deploy: string, file: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8')) as WorldSections & { logging?: Section };
  let changed = false;
  const old = config.worlds?.terminal;
  if (config.worlds && old) {
    config.worlds.console = { ...old, ...config.worlds.console };
    delete config.worlds.terminal;
    changed = true;
  }
  const logging = config.logging;
  if (logging && 'console' in logging) {
    logging.stdout ??= logging.console;
    delete logging.console;
    changed = true;
  }
  if (changed) writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  const prompts = join(deploy, 'worlds', 'terminal');
  if (existsSync(prompts) && !existsSync(join(deploy, 'worlds', 'console'))) renameSync(prompts, join(deploy, 'worlds', 'console'));
}

/** `worlds.cua` becomes `worlds.desktop-pet.cua`; a key already there stays as it is. */
function moveCuaIntoPet(file: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8')) as WorldSections;
  const old = config.worlds?.cua;
  if (!config.worlds || !old) return;
  const pet = config.worlds['desktop-pet'] ?? {};
  config.worlds['desktop-pet'] = { ...pet, cua: { ...old, ...pet.cua as Section | undefined } };
  delete config.worlds.cua;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

function keepCuaAsking(file: string): void {
  const config = JSON.parse(readFileSync(file, 'utf8')) as WorldSections;
  const pet = config.worlds?.['desktop-pet'];
  const cua = pet?.cua as Section | undefined;
  if (cua?.permission !== undefined) return;
  config.worlds = { ...config.worlds, 'desktop-pet': { ...pet, cua: { ...cua, permission: OLD_CUA_ASK } } };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

function moveEndpointsToCoo(providers: string): void {
  for (const dir of readdirSync(providers, { withFileTypes: true })) {
    const file = join(providers, dir.name, 'config.json');
    if (!dir.isDirectory() || !existsSync(file)) continue;
    const config = JSON.parse(readFileSync(file, 'utf8')) as { kind?: string };
    if (config.kind !== OLD_MODULE) continue;
    config.kind = MODULE;
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  }
}

/** SHA-256 of a file's text with line endings as LF; null when it is missing. */
const hashOf = (file: string) => (existsSync(file) ? createHash('sha256').update(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')).digest('hex') : null);

/** Each shipped self-description by the SHA-256 of its text; computed on first use. */
let shipped: Map<string, PersonaId> | null = null;

/**
 * The persona whose shipped self-description the workspace's is, in any language, exactly; null for one
 * the person or Coo changed. Self-descriptions earlier versions shipped (seed-history.ts) count as theirs.
 */
export function personaOf(workspace: string): PersonaId | null {
  const hash = hashOf(join(workspace, CONSTITUTION));
  shipped ??= new Map(PERSONAS.flatMap((id) => LANGUAGES.map((l) => [hashOf(personaFile(id, l))!, id] as const)));
  return hash === null ? null : shipped.get(hash) ?? EARLIER_PERSONAS[hash] ?? null;
}

/** Puts persona `id` in `language` in place of the workspace's self-description; the bot reads it from its next prefix on. */
export function applyPersona(workspace: string, id: PersonaId, language: Language): void {
  copyFileSync(personaFile(id, language), join(workspace, CONSTITUTION));
}

/**
 * Puts the same persona in `language` in place of a self-description still exactly as a version shipped it;
 * one the person or Coo changed stays. The bot reads the new one from its next session on.
 */
export function followLanguage(workspace: string, language: Language): void {
  const id = personaOf(workspace);
  if (id && hashOf(join(workspace, CONSTITUTION)) !== hashOf(personaFile(id, language))) applyPersona(workspace, id, language);
}
