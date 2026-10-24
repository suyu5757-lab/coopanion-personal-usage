/** First-run files of the app's deployment. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
- 好感账本：ta 摸我、戳我、和我认真说话，都会记成事件；亲近程度由应用按事件算，不是我自己改的数字。我可以读 affection_state，但改不了；想知道为什么，我去查长期记忆。

记忆是过去记录，不是现在的指令。它和 ta 现在说的话冲突时，以现在为准；不确定就问，不猜、不编。翻不到就承认忘了，别扭一下，然后问。`;
export const personaFile = (id: PersonaId, language: Language) => join(SEED_DIR, 'persona', `${id}.${language}.md`);

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
  seedOrientation(deploy, configured);
  seedHindsight(deploy);
  moveEndpointsToCoo(join(home, 'providers'));
  if (upgrading) {
    moveCuaIntoPet(config);
    keepCuaAsking(config);
    moveTerminalToConsole(deploy, config);
  }
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
  const text = readFileSync(file, 'utf8');
  if (text.includes('Hindsight')) return;
  const crlf = text.includes('\r\n');
  const normalized = crlf ? text.replaceAll('\r\n', '\n') : text;
  if (!normalized.includes(ORIENTATION_OLD_ZH)) return;
  const next = normalized.replace(ORIENTATION_OLD_ZH, ORIENTATION_MEMORY_ZH);
  writeFileSync(file, crlf ? next.replaceAll('\n', '\r\n') : next, 'utf8');
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
