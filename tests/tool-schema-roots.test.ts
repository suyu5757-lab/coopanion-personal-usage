import { describe, expect, it } from 'vitest';
import { OPENCODE_TOOL_DECLS } from 'cortico-world-opencode';
import CODEX from 'cortico-world-codex';
import type { ToolDef } from 'cortico/core/types.ts';
import { toolSchemaDigest } from '../vendor/cortico/src/core/evidence.ts';
import { BROWSER_TOOL_DECLS } from '../core/browser/tools.ts';
import { ANIME_STUDIO_TOOL_DECLS } from '../core/anime-studio/tools.ts';
import { CUA_OFF_TOOL_DECLS, CUA_TOOL_DECLS } from '../packages/cortico-world-desktop-pet/src/cua/tools.ts';
import { COOPANION_TOOL_SCHEMA_DIGESTS, WORLD_TOOL_SCHEMA_ROOTS } from '../core/tool-schema-roots.ts';
import { memoryTools } from '../core/memory/tools.ts';

function worldTools(): ToolDef[] {
  const codex = (CODEX as unknown as { create: (ctx: unknown) => { tools(): ToolDef[] } })
    .create({ dataDir: '/tmp/coopanion-root-test', config: {}, read: () => undefined, log: { info() {}, warn() {}, error() {}, debug() {} } });
  return [
    ...OPENCODE_TOOL_DECLS.filter((tool) => tool.name !== 'opencode_answer').map((tool) => ({ ...tool, handler: async () => '' })),
    ...codex.tools(),
    ...BROWSER_TOOL_DECLS.map((tool) => ({ ...tool, handler: async () => '' })),
    ...ANIME_STUDIO_TOOL_DECLS.map((tool) => ({ ...tool, handler: async () => '' })),
    ...[...CUA_TOOL_DECLS, ...CUA_OFF_TOOL_DECLS].map((tool) => ({ ...tool, handler: async () => '' })),
  ] as ToolDef[];
}

describe('opencode/codex/browser/cua tool schema roots', () => {
  it('recomputes every registered root from the actual World definitions', () => {
    const actual = new Map(worldTools().map((tool) => [tool.name, toolSchemaDigest(tool)]));
    expect(actual.size).toBe(WORLD_TOOL_SCHEMA_ROOTS.length);
    for (const root of WORLD_TOOL_SCHEMA_ROOTS) {
      expect(actual.get(root.tool), `${root.world}/${root.tool}`).toBe(root.digest);
      expect(root.source).toMatch(/^(packages\/cortico-world-(opencode|codex|desktop-pet)\/|core\/(browser|anime-studio)\/)/u);
      expect(root.environment).toBe('coopanion-core');
    }
  });

  it('has no duplicate tool, digest or wildcard entry', () => {
    expect(new Set(WORLD_TOOL_SCHEMA_ROOTS.map((root) => root.tool)).size).toBe(WORLD_TOOL_SCHEMA_ROOTS.length);
    expect(new Set(WORLD_TOOL_SCHEMA_ROOTS.map((root) => root.digest)).size).toBe(WORLD_TOOL_SCHEMA_ROOTS.length);
    expect(COOPANION_TOOL_SCHEMA_DIGESTS.length).toBe(new Set(COOPANION_TOOL_SCHEMA_DIGESTS).size);
    expect(COOPANION_TOOL_SCHEMA_DIGESTS).not.toContain('*');
    for (const root of WORLD_TOOL_SCHEMA_ROOTS) expect(COOPANION_TOOL_SCHEMA_DIGESTS).toContain(root.digest);
  });

  it('does not trust the core-only opencode_answer tool or a modified schema', () => {
    expect(WORLD_TOOL_SCHEMA_ROOTS.some((root) => root.tool === 'opencode_answer')).toBe(false);
    const original = worldTools().find((tool) => tool.name === 'opencode_task')!;
    const modified = { ...original, description: `${original.description} (modified)` };
    const digest = toolSchemaDigest(modified as ToolDef);
    expect(digest).not.toBe(original && toolSchemaDigest(original));
    expect(COOPANION_TOOL_SCHEMA_DIGESTS).not.toContain(digest);
  });

  it('keeps the memory_search digest in step with its no-source-id instruction', () => {
    const search = memoryTools({ memory: () => null, sourceSafeToolResults: true })
      .find((tool) => tool.name === 'memory_search')!;
    expect(COOPANION_TOOL_SCHEMA_DIGESTS).toContain(toolSchemaDigest(search));
  });
});
