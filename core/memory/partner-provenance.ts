import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type PartnerEntryOrigin = 'user-authored' | 'derived';
export type PartnerEntryState = 'current' | 'stale';

export interface PartnerProvenanceEntry {
  id: string;
  segmentDigest: string;
  origin: PartnerEntryOrigin;
  sourceIds: string[];
  sourceScopeDigest: string | null;
  state: PartnerEntryState;
}

export interface PartnerProvenanceFile {
  v: 1;
  workspaceDigest: string;
  entries: PartnerProvenanceEntry[];
}

export type PartnerProvenanceRead =
  | { status: 'ok'; file: PartnerProvenanceFile }
  | { status: 'missing' | 'invalid' | 'unsupported' | 'scope-mismatch' };

export interface PartnerTextResult {
  text: string;
  status: PartnerProvenanceRead['status'];
  includedSegments: number;
  withheldSegments: number;
  segments: Array<{
    text: string;
    origin: PartnerEntryOrigin;
    sourceIds: string[];
  }>;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9-]{16,64}$/i;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

export function partnerWorkspaceDigest(workspacePath: string): string {
  return digest(resolve(workspacePath));
}

export function partnerSourceScopeDigest(bankId: string, endpoint: string): string {
  return digest(JSON.stringify([bankId, endpoint]));
}

export function partnerProvenancePath(privateRoot: string, workspacePath: string): string {
  return join(privateRoot, 'partner-provenance', `${partnerWorkspaceDigest(workspacePath)}.json`);
}

export function partnerSegmentDigest(segment: string): string {
  const normalized = segment.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n').trim();
  return digest(normalized);
}

export function partnerSegments(markdown: string): Array<{ text: string; digest: string }> {
  const normalized = markdown.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized.split(/\n[ \t]*\n+/).map((text) => text.trim()).filter(Boolean)
    .map((text) => ({ text, digest: partnerSegmentDigest(text) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validEntry(value: unknown): value is PartnerProvenanceEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || !ID.test(value.id)
    || typeof value.segmentDigest !== 'string' || !SHA256.test(value.segmentDigest)
    || (value.origin !== 'user-authored' && value.origin !== 'derived')
    || (value.state !== 'current' && value.state !== 'stale')
    || (value.sourceScopeDigest !== null && (typeof value.sourceScopeDigest !== 'string' || !SHA256.test(value.sourceScopeDigest)))
    || !Array.isArray(value.sourceIds) || !value.sourceIds.every((id) => typeof id === 'string' && !!id.trim() && !/[\r\n\0]/.test(id))) return false;
  if (value.origin === 'user-authored') return value.sourceIds.length === 0 && value.sourceScopeDigest === null;
  return value.sourceIds.length > 0 && new Set(value.sourceIds).size === value.sourceIds.length && typeof value.sourceScopeDigest === 'string';
}

function parseFile(value: unknown): PartnerProvenanceFile | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.workspaceDigest !== 'string' || !SHA256.test(value.workspaceDigest)
    || !Array.isArray(value.entries) || !value.entries.every(validEntry)) return null;
  const entries = value.entries as PartnerProvenanceEntry[];
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length
    || new Set(entries.map((entry) => entry.segmentDigest)).size !== entries.length) return null;
  return { v: 1, workspaceDigest: value.workspaceDigest, entries };
}

export function readPartnerProvenance(
  file: string,
  workspaceDigest: string,
): PartnerProvenanceRead {
  if (!existsSync(file)) return { status: 'missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { status: 'invalid' };
  }
  if (isRecord(parsed) && parsed.v !== 1) return { status: 'unsupported' };
  const manifest = parseFile(parsed);
  if (!manifest) return { status: 'invalid' };
  if (manifest.workspaceDigest !== workspaceDigest) {
    return { status: 'scope-mismatch' };
  }
  return { status: 'ok', file: manifest };
}

export function filterPartnerMarkdown(
  markdown: string,
  provenance: PartnerProvenanceRead,
  sourceScopeDigest: string | null,
  sourceVisible: (sourceId: string) => boolean,
): PartnerTextResult {
  const segments = partnerSegments(markdown);
  if (provenance.status !== 'ok') {
    return { text: '', status: provenance.status, includedSegments: 0, withheldSegments: segments.length, segments: [] };
  }
  const entries = new Map(provenance.file.entries.map((entry) => [entry.segmentDigest, entry]));
  const digestCounts = new Map<string, number>();
  for (const segment of segments) digestCounts.set(segment.digest, (digestCounts.get(segment.digest) ?? 0) + 1);
  const included: Array<{ text: string; origin: PartnerEntryOrigin; sourceIds: string[] }> = [];
  for (const segment of segments) {
    const entry = entries.get(segment.digest);
    if (!entry || (digestCounts.get(segment.digest) ?? 0) !== 1 || entry.state !== 'current') continue;
    let visible = entry.origin === 'user-authored';
    if (entry.origin === 'derived' && sourceScopeDigest && entry.sourceScopeDigest === sourceScopeDigest) {
      try { visible = entry.sourceIds.every(sourceVisible); }
      catch { visible = false; }
    }
    if (visible) included.push({
      text: segment.text,
      origin: entry.origin,
      sourceIds: entry.origin === 'derived' ? [...entry.sourceIds] : [],
    });
  }
  return {
    text: included.map((segment) => segment.text).join('\n\n'),
    status: 'ok',
    includedSegments: included.length,
    withheldSegments: segments.length - included.length,
    segments: included,
  };
}

export function writePartnerProvenance(file: string, candidate: unknown): void {
  const manifest = parseFile(candidate);
  if (!manifest) throw new Error('partner provenance sidecar is invalid');
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    chmodSync(temporary, 0o600);
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  chmodSync(file, 0o600);
  chmodSync(directory, 0o700);
}

function updateEntries(
  file: string,
  workspaceDigest: string,
  update: (entry: PartnerProvenanceEntry) => PartnerProvenanceEntry,
): boolean {
  const read = readPartnerProvenance(file, workspaceDigest);
  if (read.status !== 'ok') return false;
  const entries = read.file.entries.map(update);
  if (entries.every((entry, index) => entry === read.file.entries[index])) return false;
  writePartnerProvenance(file, { ...read.file, entries });
  return true;
}

export function markPartnerSourcesStale(
  file: string,
  workspaceDigest: string,
  sourceScopeDigest: string,
  sourceIds: readonly string[],
): boolean {
  const forgotten = new Set(sourceIds.filter(Boolean));
  if (forgotten.size === 0) return false;
  return updateEntries(file, workspaceDigest, (entry) => entry.origin === 'derived'
    && entry.sourceScopeDigest === sourceScopeDigest && entry.state === 'current' && entry.sourceIds.some((id) => forgotten.has(id))
    ? { ...entry, state: 'stale' } : entry);
}

export function markPartnerDerivedStale(
  file: string,
  workspaceDigest: string,
  sourceScopeDigest: string | null,
): boolean {
  return updateEntries(file, workspaceDigest, (entry) => entry.origin === 'derived' && entry.state === 'current'
    && (!sourceScopeDigest || entry.sourceScopeDigest === sourceScopeDigest)
    ? { ...entry, state: 'stale' } : entry);
}
