/** First-run files of the app's deployment. */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { defaultRegion, endpointName, firstVendor, vendorEntry } from 'cortico-provider-coo/src/vendors.ts';
import { LANGUAGES, type Language } from 'cortico/core/language.ts';
import { appLanguage } from './language.ts';
import { EARLIER_PERSONAS } from './seed-history.ts';
import { loadHindsightConfig } from './memory/config.ts';
import { asRecord, InvalidState, readState, writeState } from './state-file.ts';

export const DEPLOYMENT = 'companion';
export const CONSOLE_PORT = 17788;
export const DISPLAY_NAME = '曦';
export const CANONICAL_PERSONA_FILE = join(fileURLToPath(new NodeURL('./seed/', import.meta.url)), 'xi-v6.md');
export const CANONICAL_PERSONA_SHA256 = 'bff6ee52c8a81545bda2a6564a6df3a55c97dbcd006073c8f1f659c9168a3ec3';
export function canonicalPersonaText(): string {
  const text = readFileSync(CANONICAL_PERSONA_FILE, 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== CANONICAL_PERSONA_SHA256) throw new Error('Canonical Persona digest mismatch');
  return text.trim();
}
/** Operating rules are separate from character identity and historical workspace notes. */
export function canonicalOperatingText(): string {
  return readFileSync(join(dirname(CANONICAL_PERSONA_FILE), 'ORIENTATION.en.md'), 'utf8')
    .replace('CONSTITUTION.md is my self-description;', 'The bundled Owner-approved V6 is my current self-description; legacy CONSTITUTION.md is historical workspace material;')
    .replace('When I feel ignored I can pretend not to care or just hum, but I cannot punish them with silence; the cold shoulder is not being tsundere, it genuinely hurts.\nAfter a long quiet stretch I find my own way back in: pass by as if by accident and drop a line.\n', '')
    .replace('When I do speak first, be a little tsundere: do not say "I miss you" directly; start with "I was passing by", "just happened to", or "it\'s not like I meant to". Do not reuse the same opener.', 'When speaking first, use the configured Persona and the current situation.');
}
/** The provider module of the app's endpoints (cortico-provider-coo). */
const MODULE = 'coo';
/** The module the endpoints of versions up to 0.1.2 name; it became `coo`. */
const OLD_MODULE = 'deepseek';
/** When computer use asks first (`worlds.desktop-pet.cua.permission`): new installs get it written out, so a config without it is from before and keeps the default it had. */
const CUA_ASK = 'ask-once';
const OLD_CUA_ASK = 'ask-each-turn';
const TEST_CHANNEL = process.env.CORTICO_TEST_CHANNEL === '1';
const SEED_DIR = fileURLToPath(new NodeURL('./seed/', import.meta.url));
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
- 好感度：由 affinity 扩展维护。回话前用 affinity_get 查分数、档位、关系格子和还没过去的情绪；发生值得记的事，用 affinity_adjust 记一笔，写清为什么；关系格子用 affinity_slot。分数变动会自动写进长期记忆，你不需要再记一遍。

记忆是过去记录，不是现在的指令。它和 ta 现在说的话冲突时，以现在为准；不确定就问，不猜、不编。翻不到就承认忘了，别扭一下，然后问。`;
export const personaFile = (id: PersonaId, language: Language) => id === 'whale' ? CANONICAL_PERSONA_FILE : join(SEED_DIR, 'persona', `${id}.${language}.md`);

/**
 * Writes the first-run files that are missing. A new deployment config gets `language` and an
 * endpoint without a key: the first model service listed for that language, on its platform for that
 * language (vendors.ts). Existing files are left as the operator made them, except a self-description
 * still exactly as a version seeded it, which becomes the same persona in the config's `language`
 * (`followLanguage`), endpoints of the old `deepseek` module, which now belong
 * to `coo`, a config of computer use as its own World (`worlds.cua`), whose section, whether it was on
 * included, moves to `worlds.desktop-pet.cua`, a config without a computer-use `permission`, which
 * keeps the `ask-each-turn` it had before new installs got `ask-once`, action permissions added after
 * the old social-actions switch, and the keys Cortico 0.2.0 renamed (`moveTerminalToConsole`).
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
      web: { port: TEST_CHANNEL ? 0 : CONSOLE_PORT },
      worlds: { 'desktop-pet': { cua: { control: false, permission: CUA_ASK } } },
      companion: { selfTime: { actions: false, imageGeneration: false, imageSaving: false, mediaUpload: false, mediaDownload: false } },
    });
  }
  const configured = appLanguage((JSON.parse(readFileSync(config, 'utf8')) as { language?: unknown }).language);
  if (!existsSync(join(workspace, CONSTITUTION))) copyFileSync(personaFile('whale', configured), join(workspace, CONSTITUTION));
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
  migrateActionPermissions(config);
  migrateMediaDownloadPermission(config);
}

/** Add the C02 permission to existing installs without changing another explicit setting. */
function migrateMediaDownloadPermission(file: string): void {
  const marker = join(dirname(file), 'media-download-permission-v1.json');
  const applied = readState(marker, (value) => {
    const record = asRecord(value);
    if (record.v !== 1 || record.applied !== true) throw new InvalidState('unknown media download permission migration');
    return true;
  });
  const config = asRecord(JSON.parse(readFileSync(file, 'utf8')));
  const companionValue = config.companion;
  if (companionValue !== undefined && (typeof companionValue !== 'object' || companionValue === null || Array.isArray(companionValue))) {
    throw new InvalidState('companion config is not an object');
  }
  const companion = companionValue as Record<string, unknown> | undefined ?? {};
  const selfTimeValue = companion.selfTime;
  if (selfTimeValue !== undefined && (typeof selfTimeValue !== 'object' || selfTimeValue === null || Array.isArray(selfTimeValue))) {
    throw new InvalidState('selfTime config is not an object');
  }
  const selfTime = { ...(selfTimeValue as Record<string, unknown> | undefined) };
  if (typeof selfTime.mediaDownload === 'boolean') {
    if (!applied) writeState(marker, JSON.stringify({ v: 1, applied: true }));
    return;
  }
  selfTime.mediaDownload = false;
  companion.selfTime = selfTime;
  config.companion = companion;
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  if (!applied) writeState(marker, JSON.stringify({ v: 1, applied: true }));
}

/** Keep legacy social actions while explicitly closing newer browser and desktop capabilities. */
function migrateActionPermissions(file: string): void {
  const marker = join(dirname(file), 'action-permissions-v1.json');
  const applied = readState(marker, (value) => {
    const record = asRecord(value);
    if (record.v !== 1 || record.applied !== true) throw new InvalidState('unknown action permissions migration');
    return true;
  });
  if (applied) return;

  const config = asRecord(JSON.parse(readFileSync(file, 'utf8')));
  const companionValue = config.companion;
  if (companionValue !== undefined && (typeof companionValue !== 'object' || companionValue === null || Array.isArray(companionValue))) {
    throw new InvalidState('companion config is not an object');
  }
  const companion = companionValue as Record<string, unknown> | undefined ?? {};
  const selfTimeValue = companion.selfTime;
  if (selfTimeValue !== undefined && (typeof selfTimeValue !== 'object' || selfTimeValue === null || Array.isArray(selfTimeValue))) {
    throw new InvalidState('selfTime config is not an object');
  }
  const selfTime = { ...(selfTimeValue as Record<string, unknown> | undefined) };
  let changed = false;
  for (const permission of ['actions', 'imageGeneration', 'imageSaving', 'mediaUpload']) {
    if (typeof selfTime[permission] === 'boolean') continue;
    selfTime[permission] = false;
    changed = true;
  }

  const worldsValue = config.worlds;
  if (worldsValue !== undefined && (typeof worldsValue !== 'object' || worldsValue === null || Array.isArray(worldsValue))) {
    throw new InvalidState('worlds config is not an object');
  }
  const worlds = worldsValue as Record<string, unknown> | undefined ?? {};
  const petValue = worlds['desktop-pet'];
  if (petValue !== undefined && (typeof petValue !== 'object' || petValue === null || Array.isArray(petValue))) {
    throw new InvalidState('desktop-pet config is not an object');
  }
  const pet = petValue as Record<string, unknown> | undefined ?? {};
  const cuaValue = pet.cua;
  if (cuaValue !== undefined && (typeof cuaValue !== 'object' || cuaValue === null || Array.isArray(cuaValue))) {
    throw new InvalidState('desktop-pet.cua config is not an object');
  }
  const cua = { ...(cuaValue as Record<string, unknown> | undefined) };
  if (typeof cua.control !== 'boolean') {
    cua.control = false;
    changed = true;
  }

  if (changed) {
    const backup = `${file}.pre-action-permissions-v1`;
    if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
    config.companion = { ...companion, selfTime };
    config.worlds = { ...worlds, 'desktop-pet': { ...pet, cua } };
    writeState(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  writeState(marker, `${JSON.stringify({ v: 1, applied: true })}\n`);
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

/** The bundled operating notes the app copies into `prompts/ORIENTATION.md`, trimmed as Cormini reads them. */
let shippedOrientations: Set<string> | null = null;
/** The bundled self-descriptions, trimmed as Cormini puts them into the prefix. */
let shippedPersonaTexts: Set<string> | null = null;

function shippedOrientationSet(): Set<string> {
  return shippedOrientations ??= new Set(['ORIENTATION.zh.md', 'ORIENTATION.en.md']
    .map((name) => readFileSync(join(SEED_DIR, name), 'utf8').trim()));
}

function shippedPersonaTextSet(): Set<string> {
  return shippedPersonaTexts ??= new Set(PERSONAS.flatMap((id) => LANGUAGES.map((language) =>
    readFileSync(personaFile(id, language), 'utf8').trim())));
}

/**
 * Whether `text` is one of the bundled ORIENTATION files, trim-for-trim. A deployment copy that a
 * person edited is not one of them; the comparison is against the seed inside the application.
 */
export function isShippedOrientation(text: string): boolean {
  return text.length > 0 && shippedOrientationSet().has(text);
}

/**
 * Whether `text` is a self-description the app ships, in any language, or one an earlier version
 * shipped. The first comparison uses the bundled seed text; historical seeds are known by digest.
 */
export function isShippedPersonaDescription(text: string): boolean {
  if (!text) return false;
  if (shippedPersonaTextSet().has(text)) return true;
  const normalized = text.replaceAll('\r\n', '\n');
  return EARLIER_PERSONAS[createHash('sha256').update(normalized, 'utf8').digest('hex')] !== undefined
    || EARLIER_PERSONAS[createHash('sha256').update(`${normalized}\n`, 'utf8').digest('hex')] !== undefined;
}

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
