import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  filterPartnerMarkdown,
  markPartnerDerivedStale,
  markPartnerSourcesStale,
  partnerSegmentDigest,
  readPartnerProvenance,
  writePartnerProvenance,
  type PartnerProvenanceEntry,
  type PartnerProvenanceFile,
} from '../core/memory/partner-provenance.ts';

const roots: string[] = [];
const root = () => {
  const path = mkdtempSync(join(tmpdir(), 'coo-partner-provenance-'));
  roots.push(path);
  return path;
};
const workspaceDigest = 'a'.repeat(64);
const scopeDigest = 'b'.repeat(64);
const entry = (id: string, text: string, origin: 'user-authored' | 'derived', sourceIds: string[] = [], state: 'current' | 'pending' | 'stale' = 'current'): PartnerProvenanceEntry => ({
  id: id.repeat(32).slice(0, 32),
  segmentDigest: partnerSegmentDigest(text),
  origin,
  sourceIds,
  sourceScopeDigest: origin === 'derived' ? scopeDigest : null,
  state,
});
const manifest = (entries: PartnerProvenanceEntry[]): PartnerProvenanceFile => ({
  v: 1,
  workspaceDigest,
  entries,
});

afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('PARTNER provenance sidecar', () => {
  it('includes only explicitly classified, unchanged, visible paragraphs', () => {
    const authored = 'The person prefers concise plans.';
    const derived = 'The person is learning piano.';
    const stale = 'The person lives downtown.';
    const untracked = 'The person is allergic to a food.';
    const file = join(root(), 'partner-provenance.json');
    writePartnerProvenance(file, manifest([
      entry('1', authored, 'user-authored'),
      entry('2', derived, 'derived', ['source-piano']),
      entry('3', stale, 'derived', ['source-old'], 'stale'),
    ]));

    const result = filterPartnerMarkdown(`${authored}\n\n${derived}\n\n${stale}\n\n${untracked}`,
      readPartnerProvenance(file, workspaceDigest), scopeDigest, (id) => id === 'source-piano');

    expect(result).toEqual({
      text: `${authored}\n\n${derived}`,
      status: 'ok',
      includedSegments: 2,
      withheldSegments: 2,
      segments: [
        { text: authored, origin: 'user-authored', sourceIds: [] },
        { text: derived, origin: 'derived', sourceIds: ['source-piano'] },
      ],
    });
  });

  it('withholds a derived paragraph when one source is no longer visible', () => {
    const text = 'A dated relationship summary.';
    const file = join(root(), 'partner-provenance.json');
    writePartnerProvenance(file, manifest([entry('1', text, 'derived', ['source-a', 'source-b'])]));

    const result = filterPartnerMarkdown(text, readPartnerProvenance(file, workspaceDigest), scopeDigest, (id) => id === 'source-a');

    expect(result).toMatchObject({ text: '', includedSegments: 0, withheldSegments: 1 });
  });

  it('withholds derived paragraphs after the configured source scope changes', () => {
    const text = 'A source-scoped paragraph.';
    const file = join(root(), 'partner-provenance.json');
    writePartnerProvenance(file, manifest([entry('1', text, 'derived', ['source-a'])]));

    const result = filterPartnerMarkdown(text, readPartnerProvenance(file, workspaceDigest), 'c'.repeat(64), () => true);

    expect(result).toMatchObject({ text: '', includedSegments: 0, withheldSegments: 1 });
  });

  it('withholds edited and duplicate paragraphs because their source association is ambiguous', () => {
    const original = 'A note with one known source.';
    const file = join(root(), 'partner-provenance.json');
    writePartnerProvenance(file, manifest([entry('1', original, 'derived', ['source-a'])]));
    const provenance = readPartnerProvenance(file, workspaceDigest);

    const edited = filterPartnerMarkdown(`${original} Updated.`, provenance, scopeDigest, () => true);
    const duplicated = filterPartnerMarkdown(`${original}\n\n${original}`, provenance, scopeDigest, () => true);

    expect(edited).toMatchObject({ text: '', includedSegments: 0, withheldSegments: 1 });
    expect(duplicated).toMatchObject({ text: '', includedSegments: 0, withheldSegments: 2 });
  });

  it('fails closed on a missing, invalid, unsupported or mismatched sidecar', () => {
    const dir = root();
    const missing = join(dir, 'missing.json');
    expect(filterPartnerMarkdown('Private note.', readPartnerProvenance(missing, workspaceDigest), scopeDigest, () => true))
      .toMatchObject({ text: '', status: 'missing', withheldSegments: 1 });

    const invalid = join(dir, 'invalid.json');
    writeFileSync(invalid, '{');
    expect(filterPartnerMarkdown('Private note.', readPartnerProvenance(invalid, workspaceDigest), scopeDigest, () => true))
      .toMatchObject({ text: '', status: 'invalid', withheldSegments: 1 });
    expect(existsSync(invalid)).toBe(true);
    expect(existsSync(`${invalid}.bad`)).toBe(false);

    const unsupported = join(dir, 'unsupported.json');
    writeFileSync(unsupported, JSON.stringify({ v: 2 }));
    expect(filterPartnerMarkdown('Private note.', readPartnerProvenance(unsupported, workspaceDigest), scopeDigest, () => true))
      .toMatchObject({ text: '', status: 'unsupported', withheldSegments: 1 });

    const mismatch = join(dir, 'mismatch.json');
    writePartnerProvenance(mismatch, manifest([entry('1', 'Private note.', 'user-authored')]));
    expect(filterPartnerMarkdown('Private note.', readPartnerProvenance(mismatch, 'c'.repeat(64)), scopeDigest, () => true))
      .toMatchObject({ text: '', status: 'scope-mismatch', withheldSegments: 1 });
  });

  it('fences only derived entries that reference forgotten source IDs', () => {
    const file = join(root(), 'partner-provenance.json');
    const otherScope = 'c'.repeat(64);
    writePartnerProvenance(file, manifest([
      entry('1', 'Affected paragraph.', 'derived', ['forgotten-source']),
      entry('2', 'Unrelated paragraph.', 'derived', ['other-source']),
      entry('3', 'Direct user note.', 'user-authored'),
      { ...entry('4', 'Same source ID in a different namespace.', 'derived', ['forgotten-source']), sourceScopeDigest: otherScope },
    ]));

    expect(markPartnerSourcesStale(file, workspaceDigest, scopeDigest, ['forgotten-source'])).toBe(true);
    const result = readPartnerProvenance(file, workspaceDigest);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.file.entries.map((item) => item.state)).toEqual(['stale', 'current', 'current', 'current']);
  });

  it('stales derived entries for the cleared source scope and keeps direct notes current', () => {
    const file = join(root(), 'partner-provenance.json');
    const otherScope = 'c'.repeat(64);
    const entries = [
      entry('1', 'Affected paragraph.', 'derived', ['source-a']),
      { ...entry('2', 'Different bank paragraph.', 'derived', ['source-b']), sourceScopeDigest: otherScope },
      entry('3', 'Direct user note.', 'user-authored'),
      entry('4', 'Already stale paragraph.', 'derived', ['source-old'], 'stale'),
    ];
    writePartnerProvenance(file, manifest(entries));

    expect(markPartnerDerivedStale(file, workspaceDigest, scopeDigest)).toBe(true);
    const result = readPartnerProvenance(file, workspaceDigest);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.file.entries.map((item) => item.state)).toEqual(['stale', 'current', 'current', 'stale']);
    expect(markPartnerDerivedStale(file, workspaceDigest, scopeDigest)).toBe(false);
  });

  it('keeps a pending registration out of current text and fences it on Forget', () => {
    const text = 'A paragraph whose source is not verified yet.';
    const file = join(root(), 'partner-provenance.json');
    writePartnerProvenance(file, manifest([entry('1', text, 'derived', ['source-a'], 'pending')]));

    expect(filterPartnerMarkdown(text, readPartnerProvenance(file, workspaceDigest), scopeDigest, () => true))
      .toMatchObject({ text: '', includedSegments: 0, withheldSegments: 1 });

    expect(markPartnerSourcesStale(file, workspaceDigest, scopeDigest, ['source-a'])).toBe(true);
    const result = readPartnerProvenance(file, workspaceDigest);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.file.entries[0]?.state).toBe('stale');
  });

  it('stores no paragraph text and keeps the sidecar private', () => {
    const dir = root();
    const directory = join(dir, 'public');
    mkdirSync(directory, { mode: 0o755 });
    const file = join(directory, 'partner-provenance.json');
    const text = 'A sensitive sentence is never copied to the sidecar.';
    writePartnerProvenance(file, manifest([entry('1', text, 'derived', ['source-a'])]));

    expect(readFileSync(file, 'utf8')).not.toContain(text);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }
  });
});
