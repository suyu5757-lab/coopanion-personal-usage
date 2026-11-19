/**
 * Rev29 §0W voice tool trust. These tests pin the exact approved identity and prove the
 * failure modes the Owner asked for: a wrong digest, a same-name tool with a different schema,
 * another World claiming the same bytes, an unapproved endpoint, and untrusted audio paths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolSchemaDigest } from '../vendor/cortico/src/core/evidence.ts';
import type { ToolDef, World } from '../vendor/cortico/src/core/types.ts';
import type { WorldContext, WorldDefinition, WorldSection } from '../vendor/cortico/src/world.ts';
import { COOPANION_TOOL_SCHEMA_DIGESTS, VOICE_TOOL_SCHEMA_ROOTS } from '../core/tool-schema-roots.ts';
import { auditVoiceWorlds, grantVoiceWorld, isVoiceToolReceipt, prepareVoiceWorlds } from '../core/voice-tool-trust.ts';

const PRODUCTION_EXTENSIONS = process.env.CORTICO_EXTENSIONS_DIR
  ?? join(homedir(), 'Library', 'Application Support', 'Coopanion', 'extensions');

const TTS = VOICE_TOOL_SCHEMA_ROOTS.find((root) => root.world === 'tts')!;
const AUDIO = VOICE_TOOL_SCHEMA_ROOTS.find((root) => root.world === 'audio-play')!;

const tempDirs: string[] = [];
let work = '';
const realTools = new Map<string, ToolDef[]>();

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `voice-trust-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** A copy of the installed packages so identity negatives never touch the real ones. */
function copyExtensions(): string {
  const dir = temp('ext');
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  for (const root of VOICE_TOOL_SCHEMA_ROOTS) {
    cpSync(
      join(PRODUCTION_EXTENSIONS, 'node_modules', ...root.package.split('/')),
      join(dir, 'node_modules', ...root.package.split('/')),
      { recursive: true, dereference: true },
    );
  }
  return dir;
}

async function loadDefinitions(dir: string): Promise<WorldDefinition<WorldSection>[]> {
  const out: WorldDefinition<WorldSection>[] = [];
  for (const root of VOICE_TOOL_SCHEMA_ROOTS) {
    const file = join(dir, 'node_modules', ...root.package.split('/'), 'src', 'definition.js');
    const mod = await import(pathToFileURL(file).href) as { default: WorldDefinition<WorldSection> };
    out.push(mod.default);
  }
  return out;
}

function context(id: string, section: Record<string, unknown>, dataDir: string): WorldContext<WorldSection> {
  return {
    id,
    cfg: { enabled: true, ...section } as WorldSection,
    timezone: 'UTC',
    botName: 'Coo',
    botDir: dataDir,
    packageDir: dataDir,
    dataDir,
    repoRoot: dataDir,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  } as WorldContext<WorldSection>;
}

function fakeWorld(id: string, tools: ToolDef[], extra: Record<string, unknown> = {}): World {
  return {
    id,
    tools: () => tools,
    envPromptVars: () => null,
    start: async () => {},
    stop: async () => {},
    ...extra,
  } as unknown as World;
}

function realTool(root: typeof TTS): ToolDef {
  const tool = (realTools.get(root.world) ?? []).find((entry) => entry.name === root.tool);
  if (!tool) throw new Error(`missing real tool ${root.tool}`);
  return tool;
}

beforeAll(async () => {
  work = temp('work');
  mkdirSync(join(work, 'tts'), { recursive: true });
  for (const definition of await loadDefinitions(PRODUCTION_EXTENSIONS)) {
    const section = definition.id === 'tts'
      ? { baseUrl: 'http://127.0.0.1:9881', voice: 'da-fei-yu' }
      : { autoPlay: false };
    realTools.set(definition.id, definition.create(context(definition.id, section, work)).tools());
  }
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('approved roots', () => {
  it('matches the Owner authorization exactly', () => {
    expect(TTS).toMatchObject({
      world: 'tts',
      package: 'cortico-world-tts',
      packageVersion: '0.1.4',
      tool: 'tts_speak',
      digest: 'd79285615beb6baba43d3cce0355db0ebfa31bcf4c772c14d480163bf339a8d5',
      source: 'cortico-world-tts/src/world.js',
      sourceSha256: '47dceb04cea22bd490bd858f0a6a72ad3775ab233d206e508fdc14ad60b06d13',
      exposes: ['tts_speak'],
      declares: ['tts_speak', 'tts_control'],
    });
    expect(AUDIO).toMatchObject({
      world: 'audio-play',
      package: 'cortico-world-audio-play',
      packageVersion: '0.1.1',
      tool: 'audio_play',
      digest: 'a42236d17e6723ec55123870db796b8fd47b83d2ac3397ffe9986b9be3a45359',
      source: 'cortico-world-audio-play/src/world.js',
      sourceSha256: '84ddf468df16aec0fd3feb10b19b068af0cb165d3b3b256653bb6446bd2d36fd',
      exposes: ['audio_play'],
      declares: ['audio_play', 'audio_watch'],
    });
  });

  it('does not add the voice digests to the unconditional trust set', () => {
    for (const root of VOICE_TOOL_SCHEMA_ROOTS) {
      expect(COOPANION_TOOL_SCHEMA_DIGESTS).not.toContain(root.digest);
    }
    expect(COOPANION_TOOL_SCHEMA_DIGESTS).not.toContain('*');
  });

  it('recomputes both digests from the installed packages', () => {
    for (const root of VOICE_TOOL_SCHEMA_ROOTS) {
      expect(toolSchemaDigest(realTool(root))).toBe(root.digest);
    }
  });
});

describe('startup audit', () => {
  it('verifies, wraps and trusts only the exposed tools', async () => {
    const definitions = await loadDefinitions(PRODUCTION_EXTENSIONS);
    const prepared = prepareVoiceWorlds(definitions, { extensionsDir: PRODUCTION_EXTENSIONS });
    expect(prepared.report.findings).toEqual([]);
    expect(prepared.report.worlds.every((entry) => entry.verified)).toBe(true);

    const instances = prepared.definitions.map((definition) => definition.create(
      context(definition.id, definition.id === 'tts'
        ? { baseUrl: 'http://127.0.0.1:9881', voice: 'da-fei-yu' }
        : { autoPlay: false }, work),
    ));
    expect(instances[0]!.tools().map((tool) => tool.name)).toEqual(['tts_speak']);
    expect(instances[1]!.tools().map((tool) => tool.name)).toEqual(['audio_play']);

    const audit = auditVoiceWorlds(instances, { extensionsDir: PRODUCTION_EXTENSIONS });
    expect(audit.findings).toEqual([]);
    expect(audit.digests.sort()).toEqual([TTS.digest, AUDIO.digest].sort());
    expect(audit.worlds.every((entry) => entry.verified && entry.executedWorldMatch)).toBe(true);
  });

  it('refuses a package with another version', async () => {
    const dir = copyExtensions();
    const pkgFile = join(dir, 'node_modules', ...TTS.package.split('/'), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { version: string };
    pkg.version = '0.1.5';
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
    const prepared = prepareVoiceWorlds(await loadDefinitions(dir), { extensionsDir: dir });
    const tts = prepared.report.worlds.find((entry) => entry.world === 'tts')!;
    expect(tts.verified).toBe(false);
    expect(tts.findings.join(' ')).toContain('package-version-mismatch');
  });

  it('refuses source bytes that differ from the reviewed file', async () => {
    const dir = copyExtensions();
    const file = join(dir, 'node_modules', ...TTS.source.split('/'));
    appendFileSync(file, '\n// unreviewed edit\n');
    expect(readFileSync(file, 'utf8')).toContain('unreviewed edit');
    const prepared = prepareVoiceWorlds(await loadDefinitions(dir), { extensionsDir: dir });
    const tts = prepared.report.worlds.find((entry) => entry.world === 'tts')!;
    expect(tts.verified).toBe(false);
    expect(tts.sourceMatch).toBe(false);
  });

  it('refuses a same-name tool whose schema changed', () => {
    const changed = { ...realTool(TTS), description: `${realTool(TTS).description} (modified)` };
    expect(toolSchemaDigest(changed)).not.toBe(TTS.digest);
    const definition: WorldDefinition<WorldSection> = {
      id: 'tts',
      label: 'tts',
      defaults: () => ({ enabled: true }) as WorldSection,
      create: () => fakeWorld('tts', [changed, { ...realTool(TTS), name: 'tts_control' }], {
        cfg: { enabled: true, baseUrl: 'http://127.0.0.1:9881', voice: 'da-fei-yu' },
      }),
    };
    const prepared = prepareVoiceWorlds([definition], { extensionsDir: PRODUCTION_EXTENSIONS });
    const tts = prepared.report.worlds.find((entry) => entry.world === 'tts')!;
    expect(tts.verified).toBe(false);
    expect(tts.findings.join(' ')).toContain('schema-digest-mismatch');
    expect(prepared.report.digests).toEqual([]);
  });

  it('drops a digest another World claims with identical bytes', () => {
    const grantedDefinition = grantVoiceWorld({
      id: 'audio-play',
      label: 'audio-play',
      defaults: () => ({ enabled: true }) as WorldSection,
      create: () => fakeWorld('audio-play', [realTool(AUDIO)], { dataDir: work }),
    }, AUDIO);
    const granted = grantedDefinition.create(context('audio-play', {}, work));
    const impostor = fakeWorld('other-voice', [realTool(AUDIO)]);
    // The impostor's bytes are the reviewed ones, so without the owner check it would be indistinguishable.
    expect(toolSchemaDigest(realTool(AUDIO))).toBe(AUDIO.digest);
    const audit = auditVoiceWorlds([granted, impostor], { extensionsDir: PRODUCTION_EXTENSIONS });
    expect(audit.digests).not.toContain(AUDIO.digest);
    expect(audit.findings.join(' ')).toContain('impersonation:other-voice');
  });

  it('does not trust an unwrapped World with the right id', () => {
    const unwrapped = fakeWorld('audio-play', [realTool(AUDIO)], { dataDir: work });
    const audit = auditVoiceWorlds([unwrapped], { extensionsDir: PRODUCTION_EXTENSIONS });
    expect(audit.digests).toEqual([]);
    expect(audit.findings.join(' ')).toContain('execution-target-not-granted');
  });
});

describe('request scope', () => {
  function grantedTts(calls: string[], section: Record<string, unknown>): World {
    const definition = grantVoiceWorld({
      id: 'tts',
      label: 'tts',
      defaults: () => ({ enabled: true }) as WorldSection,
      create: () => fakeWorld('tts', [{
        ...realTool(TTS),
        handler: async () => {
          calls.push('tts_speak');
          return 'ok';
        },
      }], { cfg: { enabled: true, ...section } }),
    }, TTS);
    return definition.create(context('tts', section, work));
  }

  it('refuses a non-loopback endpoint, another voice and event delivery', async () => {
    const calls: string[] = [];
    const remote = grantedTts(calls, { baseUrl: 'https://tts.example.com', voice: 'da-fei-yu' });
    expect(await remote.tools()[0]!.handler({ text: 'x' }, {} as never)).toMatchObject({ failed: true });
    const otherVoice = grantedTts(calls, { baseUrl: 'http://127.0.0.1:9881', voice: 'da-fei-yu' });
    expect(await otherVoice.tools()[0]!.handler({ text: 'x', voice: 'someone-else' }, {} as never)).toMatchObject({ failed: true });
    const event = grantedTts(calls, { baseUrl: 'http://127.0.0.1:9881', voice: 'da-fei-yu' });
    expect(await event.tools()[0]!.handler({ text: 'x', delivery: 'event' }, {} as never)).toMatchObject({ failed: true });
    expect(calls).toEqual([]);
  });

  it('admits the configured loopback request', async () => {
    const calls: string[] = [];
    const world = grantedTts(calls, { baseUrl: 'http://localhost:9881', voice: 'da-fei-yu' });
    expect(await world.tools()[0]!.handler({ text: 'x', voice: 'da-fei-yu' }, {} as never)).toEqual({ text: 'ok' });
    expect(calls).toEqual(['tts_speak']);
  });

  function grantedAudio(calls: string[]): World {
    const definition = grantVoiceWorld({
      id: 'audio-play',
      label: 'audio-play',
      defaults: () => ({ enabled: true }) as WorldSection,
      create: () => fakeWorld('audio-play', [{
        ...realTool(AUDIO),
        handler: async () => {
          calls.push('audio_play');
          return 'ok';
        },
      }], { dataDir: work }),
    }, AUDIO);
    return definition.create(context('audio-play', {}, work));
  }

  it('refuses file:, mem:, http:, relative and out-of-root paths', async () => {
    const calls: string[] = [];
    const world = grantedAudio(calls);
    const outside = join(work, 'outside.wav');
    writeFileSync(outside, Buffer.alloc(0));
    const link = join(work, 'tts', 'escape.wav');
    symlinkSync(outside, link);
    for (const audio of [
      `file://${outside}`,
      'mem:workspace/file.wav',
      'https://example.com/a.wav',
      'clips/a.wav',
      '../outside.wav',
      outside,
      link,
    ]) {
      expect(await world.tools()[0]!.handler({ audio }, {} as never), audio).toMatchObject({ failed: true });
    }
    expect(calls).toEqual([]);
  });

  it('admits a conversation handle and a clip inside the controlled directory', async () => {
    const calls: string[] = [];
    const world = grantedAudio(calls);
    const clip = join(work, 'tts', 'ok.wav');
    writeFileSync(clip, Buffer.alloc(0));
    expect(await world.tools()[0]!.handler({ audio: 'log:attachment-1' }, {} as never)).toEqual({ text: 'ok' });
    expect(await world.tools()[0]!.handler({ audio: clip }, {} as never)).toEqual({ text: 'ok' });
    expect(calls).toEqual(['audio_play', 'audio_play']);
  });

  it('marks only its own receipts so the Host can admit them', async () => {
    const tts = grantedTts([], { baseUrl: 'http://127.0.0.1:9881', voice: 'da-fei-yu' });
    const ok = await tts.tools()[0]!.handler({ text: 'x' }, {} as never);
    expect(isVoiceToolReceipt('tts_speak', ok)).toBe(true);
    expect(isVoiceToolReceipt('audio_play', ok)).toBe(false);

    const refused = await grantedTts([], { baseUrl: 'https://remote.example', voice: 'da-fei-yu' })
      .tools()[0]!.handler({ text: 'x' }, {} as never);
    expect(isVoiceToolReceipt('tts_speak', refused)).toBe(true);
    expect((refused as { failed?: true }).failed).toBe(true);
  });
});
