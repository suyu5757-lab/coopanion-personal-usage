import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderWorldEnvPrompt } from 'cortico/core/prefix.ts';
import type { World } from 'cortico/core/types.ts';
import {
  CODEX_TRUSTED_TEMPLATE_DIGESTS,
  OPENCODE_TRUSTED_TEMPLATE_DIGESTS,
  coopanionWorldPromptTrust,
  withTrustedWorldVariables,
} from '../core/world-prompt-trust.ts';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function coversEveryVisibleCharacter(text: string, spans: { start: number; end: number }[] | undefined): boolean {
  const covered = new Uint8Array(text.length);
  for (const span of spans ?? []) for (let i = span.start; i < span.end; i++) covered[i] = 1;
  for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i]!) && covered[i] !== 1) return false;
  return true;
}

function fakeWorld(id: 'opencode' | 'codex', file: string, vars: Record<string, string>): World {
  return {
    id,
    envPromptVars: () => vars,
    webUi: () => ({ promptDocs: [{ key: `worlds.${id}.envPrompt`, title: id, path: file, role: 'envPrompt' }] }),
  } as unknown as World;
}

describe('opencode/codex World prompt trust', () => {
  it('pins the four bundled templates by exact digest', () => {
    const root = join(import.meta.dirname, '..');
    expect(OPENCODE_TRUSTED_TEMPLATE_DIGESTS).toContain(sha256(readFileSync(join(root, 'packages', 'cortico-world-opencode', 'src', 'ENV_PROMPT.md'), 'utf8')));
    expect(OPENCODE_TRUSTED_TEMPLATE_DIGESTS).toContain(sha256(readFileSync(join(root, 'packages', 'cortico-world-opencode', 'src', 'ENV_PROMPT.en.md'), 'utf8')));
    expect(CODEX_TRUSTED_TEMPLATE_DIGESTS).toContain(sha256(readFileSync(join(root, 'packages', 'cortico-world-codex', 'ENV_PROMPT.md'), 'utf8')));
    expect(CODEX_TRUSTED_TEMPLATE_DIGESTS).toContain(sha256(readFileSync(join(root, 'packages', 'cortico-world-codex', 'ENV_PROMPT.en.md'), 'utf8')));
  });

  it('renders trusted opencode and codex prompts with core-generated variable spans', async () => {
    const root = join(import.meta.dirname, '..');
    for (const [id, file, vars] of [
      ['opencode', join(root, 'packages', 'cortico-world-opencode', 'src', 'ENV_PROMPT.md'), { 'opencode.roots': '/tmp/root' }],
      ['codex', join(root, 'packages', 'cortico-world-codex', 'ENV_PROMPT.md'), { 'codex.roots': '/tmp/root', 'codex.taskMinutes': '30' }],
    ] as const) {
      const world = withTrustedWorldVariables(fakeWorld(id, file, vars));
      const rendered = await renderWorldEnvPrompt(world, undefined, coopanionWorldPromptTrust);
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(coversEveryVisibleCharacter(rendered.text, rendered.sourceMapSpans)).toBe(true);
      for (const value of Object.values(vars)) {
        const at = rendered.text.indexOf(value);
        if (at < 0) continue;
        expect(rendered.sourceMapSpans).toContainEqual({
          start: at, end: at + value.length, digest: sha256(value), origin: 'core-generated',
        });
      }
    }
  });
});
