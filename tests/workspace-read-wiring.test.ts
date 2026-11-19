import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { coopanionPersona } from '../core/persona.ts';
import type { HindsightMemory } from '../core/memory/hindsight.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'coo-w4-read-'));
  roots.push(root);
  mkdirSync(join(root, 'mind'), { recursive: true });
  writeFileSync(join(root, 'mind', 'synthetic.md'), '合成工作区内容，仅用于 W4 边界测试。\n', 'utf8');
  return root;
}

async function read(root: string, memory?: HindsightMemory, path = 'mind/synthetic.md'): Promise<{ text: string; spans: Array<{ origin: string }> }> {
  const Persona = coopanionPersona(Cormini, memory ? { memory } : {});
  const persona = new Persona({ memoryDir: root });
  const tools = (persona as unknown as { tools(): Array<{ name: string; handler: (args: Record<string, unknown>, ctx: unknown) => Promise<unknown> }> }).tools();
  const readFile = tools.find((tool) => tool.name === 'read_file');
  if (!readFile) throw new Error('read_file missing');
  const out = await readFile.handler({ path }, { role: 'main', callId: 'w4-read' });
  if (typeof out === 'string') return { text: out, spans: [] };
  const record = out as { text?: unknown; sourceMapSpans?: Array<{ origin: string }> };
  return { text: String(record.text ?? ''), spans: record.sourceMapSpans ?? [] };
}

describe('W4 workspace read wiring', () => {
  it('always uses the memory-first label and returns the workspace body on the real read_file tool', async () => {
    const root = workspace();
    const readOut = await read(root);
    expect(readOut.text).toContain('historicalEvidence=unverified');
    expect(readOut.text).toContain('workspaceMaterial=1');
    expect(readOut.text).toContain('memory_search');
    expect(readOut.text).toContain('合成工作区内容');
    expect(readOut.spans.every((span) => span.origin === 'core-generated')).toBe(true);
  });

  it('refuses a journal body when its Bank source was forgotten', async () => {
    const root = workspace();
    mkdirSync(join(root, 'journal'), { recursive: true });
    writeFileSync(join(root, 'journal', '2026-10-25.md'), '合成日记正文，不得在遗忘后返回。\n', 'utf8');
    const memory = {
      historySourceStatus: (documentId: string) => documentId === 'journal:2026-10-25' ? 'forgotten' : 'visible',
    } as unknown as HindsightMemory;
    const readOut = await read(root, memory, 'journal/2026-10-25.md');
    expect(readOut.text).toContain('historicalEvidence=fenced');
    expect(readOut.text).not.toContain('合成日记正文');
  });
});
