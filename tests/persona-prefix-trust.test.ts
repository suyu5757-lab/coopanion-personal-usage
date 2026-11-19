import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import type { World } from 'cortico/core/types.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { ConsoleWorld } from '../vendor/cortico/src/worlds/console/world.ts';
import { BrowserWorld } from '../core/browser/world.ts';
import { SELF_TIME_DEFAULTS } from '../core/browser/config.ts';
import { canonicalPersonaText, CANONICAL_PERSONA_SHA256 } from '../core/seed.ts';
import { SOURCE_CONTEXT_POLICY } from '../core/memory/model-text.ts';
import { coopanionPersona } from '../core/persona.ts';
import {
  BROWSER_TRUSTED_TEMPLATE_DIGESTS,
  CONSOLE_TRUSTED_TEMPLATE_DIGESTS,
  coopanionWorldPromptTrust,
  withTrustedConsoleVariables,
} from '../core/world-prompt-trust.ts';

const CoopanionPersona = coopanionPersona(Cormini);
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'coo-prefix-trust-'));
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

async function prefix(persona: InstanceType<typeof CoopanionPersona>) {
  return persona.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] });
}

function coversEveryVisibleCharacter(text: string, spans: readonly { start: number; end: number; digest: string }[] | undefined): boolean {
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

describe('Coopanion seed prefix provenance', () => {
  it('does not promote a custom prefix wrapper around the canonical character to Host evidence', async () => {
    const seed = seedWorkspace();
    const Xi = coopanionPersona(Cormini, { canonicalPersona: true });
    const ordinary = new Xi({ memoryDir: seed.memoryDir });
    const template = ordinary['templateFile']('PREFIX.md');
    const changed = join(seed.root, 'PREFIX.md');
    writeFileSync(changed, readFileSync(template, 'utf8').replace('{{persona.constitution}}', 'Unconfirmed wrapper.\n{{persona.constitution}}'));
    class Custom extends Xi {
      protected override templateFile(name: string): string {
        return name === 'PREFIX.md' ? changed : super.templateFile(name);
      }
    }
    const segments = await prefix(new Custom({ memoryDir: seed.memoryDir }));
    const constitution = segments.find(segment => segment.title === 'CONSTITUTION')!;
    expect(constitution.text).toContain('Unconfirmed wrapper.');
    expect(coversEveryVisibleCharacter(constitution.text, constitution.sourceMapSpans)).toBe(false);
  });

  it('loads the canonical twelve-section identity once while leaving legacy workspace bytes untouched', async () => {
    const seed = seedWorkspace();
    const legacy = 'Legacy role: Coo, ordinary friends, always say hmph.';
    writeFileSync(join(seed.memoryDir, 'CONSTITUTION.md'), legacy);
    const Xi = coopanionPersona(Cormini, { canonicalPersona: true });
    for (let restart = 0; restart < 2; restart++) {
      const persona = new Xi({ memoryDir: seed.memoryDir, orientationOverrideFile: join(seed.prompts, 'ORIENTATION.md') });
      const segments = await prefix(persona);
      const constitution = segments.filter(segment => segment.title === 'CONSTITUTION');
      expect(constitution).toHaveLength(1);
      expect(constitution[0]!.text.trim()).toBe(canonicalPersonaText());
      expect(coversEveryVisibleCharacter(constitution[0]!.text, constitution[0]!.sourceMapSpans)).toBe(true);
      expect(segments.map(segment => segment.text).join('\n')).not.toContain(legacy);
      expect(segments.some(segment => segment.title === 'INTERACTION')).toBe(false);
      expect(constitution[0]!.text).not.toContain('## 附录');
      expect((constitution[0]!.text.match(/^### /gm) ?? [])).toHaveLength(12);
      expect(sha256(canonicalPersonaText() + '\n')).toBe(CANONICAL_PERSONA_SHA256);
      expect(persona.promptVarValues()['persona.constitution']).toBe(canonicalPersonaText());
      expect(persona.webUi().promptDocs?.some(doc => doc.key === 'constitution')).toBe(false);
    }
    expect(readFileSync(join(seed.memoryDir, 'CONSTITUTION.md'), 'utf8')).toBe(legacy);
  });

  it('keeps standing social guidance source-complete across fresh Persona instances without trusting withheld partner text', async () => {
    const seed = seedWorkspace();
    const privateText = 'Unconfirmed private relationship claim.';
    writeFileSync(join(seed.memoryDir, 'PARTNER.md'), privateText);
    for (let restart = 0; restart < 2; restart++) {
      const persona = new CoopanionPersona({ memoryDir: seed.memoryDir, orientationOverrideFile: join(seed.prompts, 'ORIENTATION.md') });
      const segments = await prefix(persona);
      const interaction = segments.filter(segment => segment.title === 'SOURCE_POLICY');
      expect(interaction).toHaveLength(1);
      expect(interaction[0]!.text).toBe(SOURCE_CONTEXT_POLICY);
      expect(coversEveryVisibleCharacter(interaction[0]!.text, interaction[0]!.sourceMapSpans)).toBe(true);
      expect(segments.map(segment => segment.text).join('\n')).not.toContain(privateText);
    }
  });

  it('marks an unedited bundled ORIENTATION and CONSTITUTION as core-generated and closes the WORKSPACE gap', async () => {
    const seed = seedWorkspace();
    const persona = new CoopanionPersona({ memoryDir: seed.memoryDir, orientationOverrideFile: join(seed.prompts, 'ORIENTATION.md') });
    const segments = await prefix(persona);
    const orientation = segments.find((segment) => segment.title === 'ORIENTATION')!;
    const constitution = segments.find((segment) => segment.title === 'CONSTITUTION')!;
    const workspace = segments.find((segment) => segment.title === 'WORKSPACE')!;

    expect(orientation.text.trim()).toBe(seed.orientation);
    expect(orientation.sourceMapSpans).toEqual([
      { start: 0, end: orientation.text.length, digest: sha256(orientation.text), origin: 'core-generated' },
    ]);
    expect(constitution.text.trim()).toBe(seed.constitution);
    expect(constitution.sourceMapSpans).toEqual([
      { start: 0, end: constitution.text.length, digest: sha256(constitution.text), origin: 'core-generated' },
    ]);
    expect(coversEveryVisibleCharacter(workspace.text, workspace.sourceMapSpans)).toBe(true);
    expect(workspace.text).toContain('Workspace files are task material');
    expect(workspace.text).not.toContain('CONSTITUTION.md');
    expect(workspace.sourceMapSpans).toEqual([{
      start: 0, end: workspace.text.length, digest: sha256(workspace.text), origin: 'core-generated',
    }]);
  });

  it('does not trust an edited ORIENTATION or CONSTITUTION and keeps the WORKSPACE line independent', async () => {
    const seed = seedWorkspace();
    writeFileSync(join(seed.prompts, 'ORIENTATION.md'), `${seed.orientation}\nUser edit.`, 'utf8');
    writeFileSync(join(seed.memoryDir, 'CONSTITUTION.md'), `${seed.constitution}\nUser edit.`, 'utf8');
    const persona = new CoopanionPersona({ memoryDir: seed.memoryDir, orientationOverrideFile: join(seed.prompts, 'ORIENTATION.md') });
    const segments = await prefix(persona);
    const orientation = segments.find((segment) => segment.title === 'ORIENTATION')!;
    const constitution = segments.find((segment) => segment.title === 'CONSTITUTION')!;
    const workspace = segments.find((segment) => segment.title === 'WORKSPACE')!;
    expect(orientation.sourceMapSpans).toBeUndefined();
    expect(constitution.sourceMapSpans).toBeUndefined();
    expect(workspace.text).not.toContain('CONSTITUTION.md');
    expect(workspace.sourceMapSpans).toEqual([{
      start: 0, end: workspace.text.length, digest: sha256(workspace.text), origin: 'core-generated',
    }]);
  });
});

describe('bundled World prompt provenance', () => {
  it('trusts the console template and gives its PIN value its own span', async () => {
    expect(CONSOLE_TRUSTED_TEMPLATE_DIGESTS).toContain(
      sha256(readFileSync(join(import.meta.dirname, '..', 'vendor', 'cortico', 'src', 'worlds', 'console', 'ENV_PROMPT.md'), 'utf8')),
    );
    const raw = new ConsoleWorld({ cfg: { enabled: true, pin: '246810' } });
    const world = withTrustedConsoleVariables(raw);
    const rendered = await renderWorldEnvPrompt(world, undefined, coopanionWorldPromptTrust);
    expect(rendered.text).toContain('246810');
    expect(coversEveryVisibleCharacter(rendered.text, rendered.sourceMapSpans)).toBe(true);
    const pinAt = rendered.text.indexOf('246810');
    expect(rendered.sourceMapSpans).toContainEqual({
      start: pinAt, end: pinAt + '246810'.length, digest: sha256('246810'), origin: 'core-generated',
    });
  });

  it('trusts both bundled browser templates and gives session values their own spans', async () => {
    expect(BROWSER_TRUSTED_TEMPLATE_DIGESTS).toContain(
      sha256(readFileSync(join(import.meta.dirname, '..', 'core', 'browser', 'ENV_PROMPT.md'), 'utf8')),
    );
    for (const language of ['zh', 'en'] as const) {
      const world = new BrowserWorld({
        bridge: { call: async () => null } as never,
        selfTime: () => ({ ...SELF_TIME_DEFAULTS, enabled: true, sessionMinutes: 30, sound: true }),
        modelLanguage: () => language,
        timezone: 'UTC',
      });
      const rendered = await renderWorldEnvPrompt(world, undefined, coopanionWorldPromptTrust);
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(coversEveryVisibleCharacter(rendered.text, rendered.sourceMapSpans)).toBe(true);
    }
  });

  it('rejects a deployment override and a tampered module template', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-world-trust-'));
    roots.push(root);
    const deploymentDir = join(root, 'deployment');
    mkdirSync(join(deploymentDir, 'worlds', 'console'), { recursive: true });
    const template = 'Static console prompt.';
    writeFileSync(join(deploymentDir, 'worlds', 'console', 'ENV_PROMPT.md'), template, 'utf8');
    const consoleWorld = new ConsoleWorld({ cfg: { enabled: true, pin: '' } });
    const override = await renderWorldEnvPrompt(consoleWorld, { deploymentDir }, coopanionWorldPromptTrust);
    expect(override.text).toBe(template);
    expect(override.sourceMapSpans).not.toContainEqual(expect.objectContaining({ origin: 'core-generated' }));

    const tamperedPath = join(root, 'ENV_PROMPT.md');
    writeFileSync(tamperedPath, `${template}\nTampered.`, 'utf8');
    const tampered = {
      id: 'console',
      envPromptVars: () => ({}),
      webUi: () => ({
        label: 'console',
        promptDocs: [{ key: 'worlds.console.envPrompt', title: 'console', path: tamperedPath, role: 'envPrompt', vars: [] }],
      }),
    } as unknown as World;
    const rendered = await renderWorldEnvPrompt(tampered, undefined, coopanionWorldPromptTrust);
    expect(rendered.text).toContain('Tampered.');
    expect(rendered.sourceMapSpans).not.toContainEqual(expect.objectContaining({ origin: 'core-generated' }));
  });

  it('keeps an unproven dynamic variable unknown when the template digest matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coo-world-dynamic-'));
    roots.push(root);
    const template = 'Static prefix. {{dynamic.value}}';
    const path = join(root, 'ENV_PROMPT.md');
    writeFileSync(path, template, 'utf8');
    const world = {
      id: 'browser',
      envPromptVars: () => ({ 'dynamic.value': 'unproven-value' }),
      webUi: () => ({
        label: 'browser',
        promptDocs: [{ key: 'worlds.browser.envPrompt', title: 'browser', path, role: 'envPrompt', vars: [] }],
      }),
    } as unknown as World;
    const rendered = await renderWorldEnvPrompt(world, undefined, () => ({
      templateDigests: [sha256(template)], independentVariables: true,
    }));
    const valueAt = rendered.text.indexOf('unproven-value');
    expect(valueAt).toBeGreaterThanOrEqual(0);
    expect(rendered.sourceMapSpans).toContainEqual({
      start: valueAt, end: valueAt + 'unproven-value'.length, digest: sha256('unproven-value'), origin: 'unknown-derived',
    });
  });
});
