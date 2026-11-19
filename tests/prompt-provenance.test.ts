import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import { inspectContextEvidence, verifyToolTextOrigins } from 'cortico/core/evidence.ts';
import type { World } from 'cortico/core/types.ts';
import { PromptProvenance } from '../core/prompt-provenance.ts';
import { coopanionPersona } from '../core/persona.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedRoot() {
  const root = mkdtempSync(join(tmpdir(), 'coo-prompt-provenance-'));
  roots.push(root);
  const memoryDir = join(root, 'workspace');
  const prompts = join(root, 'prompts');
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(prompts, { recursive: true });
  const orientation = readFileSync(join(import.meta.dirname, '..', 'core', 'seed', 'ORIENTATION.zh.md'), 'utf8').trim();
  const constitution = readFileSync(join(import.meta.dirname, '..', 'core', 'seed', 'persona', 'coo.zh.md'), 'utf8').trim();
  writeFileSync(join(prompts, 'ORIENTATION.md'), `${orientation}\n`, 'utf8');
  writeFileSync(join(memoryDir, 'CONSTITUTION.md'), `${constitution}\n`, 'utf8');
  writeFileSync(join(memoryDir, 'PARTNER.md'), '', 'utf8');
  return { root, memoryDir, prompts, orientation, constitution };
}

function provenance(root: string, memoryDir: string): PromptProvenance {
  const record = new PromptProvenance();
  record.configure({ rootDir: root, memoryDir });
  return record;
}

function covers(text: string, spans: readonly { start: number; end: number; digest: string }[] | undefined): boolean {
  if (!spans?.length) return false;
  const covered = new Uint8Array(text.length);
  for (const span of spans) {
    if (span.start < 0 || span.end <= span.start || span.end > text.length) return false;
    if (span.digest !== sha256(text.slice(span.start, span.end))) return false;
    for (let at = span.start; at < span.end; at++) covered[at] = 1;
  }
  for (let at = 0; at < text.length; at++) if (!/\s/u.test(text[at]!) && covered[at] !== 1) return false;
  return true;
}

describe('PromptProvenance', () => {
  it('attests exact allow-listed content and rejects an edit', () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const file = join(seed.prompts, 'ORIENTATION.md');
    const content = `${seed.orientation}\n我的补充。\n`;
    writeFileSync(file, content, 'utf8');
    expect(record.attest({ key: 'orientation', path: file, content })).toBe(true);
    expect(record.verify({ key: 'orientation', path: file, content })).toMatchObject({ ok: true });
    expect(record.verify({ key: 'orientation', path: file, content: `${content}改动` })).toMatchObject({
      ok: false, reason: 'digest-mismatch',
    });
    expect(readFileSync(join(seed.root, 'prompt-provenance.json'), 'utf8')).not.toContain('我的补充');
  });

  it('rejects arbitrary paths, wrong keys and symlinks', () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const outside = join(seed.root, 'outside.md');
    writeFileSync(outside, 'not a persona\n', 'utf8');
    expect(record.attest({ key: 'orientation', path: outside, content: 'not a persona\n' })).toBe(false);
    expect(record.attest({ key: 'worlds.browser.envPrompt', path: 'relative.md', content: 'x' })).toBe(false);
    const link = join(seed.prompts, 'ORIENTATION.md.link');
    symlinkSync(join(seed.prompts, 'ORIENTATION.md'), link);
    expect(record.attest({ key: 'orientation', path: link, content: seed.orientation })).toBe(false);
  });

  it('revokes a record and fails closed on a corrupt manifest', () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const file = join(seed.memoryDir, 'CONSTITUTION.md');
    const content = readFileSync(file, 'utf8');
    expect(record.attest({ key: 'constitution', path: file, content })).toBe(true);
    expect(record.revoke('constitution')).toBe(true);
    expect(record.verify({ key: 'constitution', path: file, content })).toMatchObject({ ok: false, reason: 'revoked' });

    writeFileSync(join(seed.root, 'prompt-provenance.json'), '{ broken', 'utf8');
    expect(record.verify({ key: 'constitution', path: file, content })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(record.attest({ key: 'constitution', path: file, content })).toBe(true);
    expect(record.verify({ key: 'constitution', path: file, content })).toMatchObject({ ok: true });
  });

  it('ties a record to the deployment root and the world template path', () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const worldDir = join(seed.root, 'worlds', 'browser');
    mkdirSync(worldDir, { recursive: true });
    const file = join(worldDir, 'ENV_PROMPT.md');
    const template = '## browser\n{{browser.audio}}\n';
    writeFileSync(file, template, 'utf8');
    expect(record.attest({ key: 'worlds.browser.envPrompt', path: file, content: template })).toBe(true);
    expect(record.verifyWorldTemplate('browser', file, sha256(template))).toBe(true);
    expect(record.verifyWorldTemplate('browser', file, sha256(`${template} `))).toBe(false);
    expect(record.verifyWorldTemplate('console', file, sha256(template))).toBe(false);

    const other = provenance(join(seed.root, 'elsewhere'), seed.memoryDir);
    rmSync(join(seed.root, 'elsewhere'), { recursive: true, force: true });
    expect(other.verify({ key: 'worlds.browser.envPrompt', path: file, content: template })).toMatchObject({ ok: false });
  });
});

describe('Coopanion local-config prefix provenance', () => {
  it('maps confirmed ORIENTATION and CONSTITUTION to user-config and covers the prefix', async () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const orientationFile = join(seed.prompts, 'ORIENTATION.md');
    const constitutionFile = join(seed.memoryDir, 'CONSTITUTION.md');
    const orientation = `${seed.orientation}\n我的补充。\n`;
    const constitution = `${seed.constitution}\n我的原则补充。\n`;
    writeFileSync(orientationFile, orientation, 'utf8');
    writeFileSync(constitutionFile, constitution, 'utf8');
    expect(record.attest({ key: 'orientation', path: orientationFile, content: orientation.trim() })).toBe(true);
    expect(record.attest({ key: 'constitution', path: constitutionFile, content: constitution.trim() })).toBe(true);

    const Persona = coopanionPersona(Cormini, { promptProvenance: record });
    const persona = new Persona({
      memoryDir: seed.memoryDir,
      orientationOverrideFile: orientationFile,
    });
    const segments = await persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] });
    const orientationSegment = segments.find((segment) => segment.title === 'ORIENTATION')!;
    const constitutionSegment = segments.find((segment) => segment.title === 'CONSTITUTION')!;
    expect(orientationSegment.sourceMapSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'user-config' }),
    ]));
    expect(constitutionSegment.sourceMapSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'user-config' }),
    ]));
    expect(covers(orientationSegment.text, orientationSegment.sourceMapSpans)).toBe(true);
    expect(covers(constitutionSegment.text, constitutionSegment.sourceMapSpans)).toBe(true);
  });

  it('withholds the config after an edit outside the settings path', async () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const orientationFile = join(seed.prompts, 'ORIENTATION.md');
    const orientation = `${seed.orientation}\n我的补充。\n`;
    writeFileSync(orientationFile, orientation, 'utf8');
    expect(record.attest({ key: 'orientation', path: orientationFile, content: orientation.trim() })).toBe(true);
    writeFileSync(orientationFile, `${orientation}又改了一次。\n`, 'utf8');
    const Persona = coopanionPersona(Cormini, { promptProvenance: record });
    const persona = new Persona({
      memoryDir: seed.memoryDir,
      orientationOverrideFile: orientationFile,
    });
    const segments = await persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] });
    const segment = segments.find((entry) => entry.title === 'ORIENTATION')!;
    expect(segment.sourceMapSpans ?? []).not.toContainEqual(expect.objectContaining({ origin: 'user-config' }));
  });

  it('includes a confirmed user-authored PARTNER paragraph and withholds it without confirmation', async () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const partnerFile = join(seed.memoryDir, 'PARTNER.md');
    const paragraph = '我喜欢下雨天。';
    writeFileSync(partnerFile, paragraph, 'utf8');
    const Persona = coopanionPersona(Cormini, { promptProvenance: record, growthStateFile: join(seed.root, 'growth.json') });
    const before = new Persona({ memoryDir: seed.memoryDir, orientationOverrideFile: join(seed.prompts, 'ORIENTATION.md') });
    const beforeSegments = await before.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] });
    expect(beforeSegments.find((segment) => segment.title === 'PARTNER')!.text).not.toContain(paragraph);

    expect(record.attest({ key: 'partner', path: partnerFile, content: paragraph })).toBe(true);
    const after = new Persona({ memoryDir: seed.memoryDir, orientationOverrideFile: join(seed.prompts, 'ORIENTATION.md') });
    const afterSegments = await after.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] });
    const partner = afterSegments.find((segment) => segment.title === 'PARTNER')!;
    expect(partner.text).toContain(paragraph);
    expect(partner.sourceMapSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'user-config' }),
    ]));
    expect(covers(partner.text, partner.sourceMapSpans)).toBe(true);
  });

  it('treats a confirmed PARTNER file without a sidecar as user-authored notes', async () => {
    const seed = seedRoot();
    const record = provenance(seed.root, seed.memoryDir);
    const partnerFile = join(seed.memoryDir, 'PARTNER.md');
    const paragraph = '我喜欢晴天。';
    writeFileSync(partnerFile, paragraph, 'utf8');
    expect(record.attest({ key: 'partner', path: partnerFile, content: paragraph })).toBe(true);
    const Persona = coopanionPersona(Cormini, { promptProvenance: record, growthStateFile: join(seed.root, 'growth.json') });
    const persona = new Persona({ memoryDir: seed.memoryDir, orientationOverrideFile: join(seed.prompts, 'ORIENTATION.md') });
    const segments = await persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] });
    const partner = segments.find((segment) => segment.title === 'PARTNER')!;
    expect(partner.text).toContain(paragraph);
    expect(partner.sourceMapSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'user-config' }),
    ]));
    expect(covers(partner.text, partner.sourceMapSpans)).toBe(true);
  });
});

describe('Core boundary for user-config spans', () => {
  const text = '配置正文';
  const record = {
    item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    context: {
      sourceMapSpans: [{ start: 0, end: text.length, digest: sha256(text), origin: 'user-config' }],
    },
  } as never;
  it('accepts a source-independent user-config span without exposed sources', () => {
    const result = inspectContextEvidence([record]);
    expect(result.mappingState).toBe('complete');
    expect(result.exposedSources).toEqual([]);
    expect(result.items[0]).toMatchObject({ disposition: 'provably-source-independent', mappingState: 'complete' });
  });

  it('downgrades a user-config claim from tool text', () => {
    const spans = verifyToolTextOrigins('read_file', text, [{
      start: 0, end: text.length, digest: sha256(text), origin: 'user-config',
    }], () => true);
    expect(spans).toEqual([expect.objectContaining({ origin: 'unverified-derived' })]);
  });

  it('downgrades a user-config variable supplied by a World even when its other variables are independent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-user-config-world-'));
    roots.push(root);
    const file = join(root, 'ENV_PROMPT.md');
    writeFileSync(file, '{{world.value}}\n', 'utf8');
    const world = {
      id: 'fixture',
      envPromptVars: async () => ({
        'world.value': {
          text,
          sourceMapSpans: [{ start: 0, end: text.length, digest: sha256(text), origin: 'user-config' }],
        },
      }),
      webUi: () => ({
        promptDocs: [{ key: 'worlds.fixture.envPrompt', title: 'fixture', description: '', path: file, role: 'envPrompt', vars: [] }],
      }),
    } as unknown as World;
    const rendered = await renderWorldEnvPrompt(world, undefined, () => ({
      templateDigests: [], independentVariables: true,
    }));
    expect(rendered.sourceMapSpans ?? []).not.toContainEqual(expect.objectContaining({ origin: 'user-config' }));
    expect(rendered.sourceMapSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'unverified-derived' }),
    ]));
  });
});

describe('World prompt local-config trust', () => {
  it('uses user-config only for the exact attested deployment override', async () => {
    const seed = seedRoot();
    const worldDir = join(seed.root, 'worlds', 'browser');
    mkdirSync(worldDir, { recursive: true });
    const file = join(worldDir, 'ENV_PROMPT.md');
    const template = '## browser\n{{browser.audio}}\n';
    writeFileSync(file, template, 'utf8');
    const record = provenance(seed.root, seed.memoryDir);
    expect(record.attest({ key: 'worlds.browser.envPrompt', path: file, content: template })).toBe(true);
    const world = {
      id: 'browser',
      envPromptVars: async () => ({ 'browser.audio': '静音' }),
      webUi: () => ({
        promptDocs: [{ key: 'worlds.browser.envPrompt', title: 'browser', description: '', path: file, role: 'envPrompt', vars: [] }],
      }),
    } as unknown as World;
    const trusted = await renderWorldEnvPrompt(world, { deploymentDir: seed.root }, () => ({
      templateDigests: [],
      independentVariables: true,
      deploymentOverride: (path, digest) => record.verifyWorldTemplate('browser', path, digest),
    }));
    expect(trusted.sourceMapSpans).toEqual(expect.arrayContaining([
      expect.objectContaining({ origin: 'user-config' }),
    ]));
    expect(covers(trusted.text, trusted.sourceMapSpans)).toBe(true);

    const untrusted = await renderWorldEnvPrompt(world, { deploymentDir: seed.root }, () => ({
      templateDigests: [],
      independentVariables: true,
    }));
    expect(untrusted.sourceMapSpans ?? []).not.toContainEqual(expect.objectContaining({ origin: 'user-config' }));
  });
});
