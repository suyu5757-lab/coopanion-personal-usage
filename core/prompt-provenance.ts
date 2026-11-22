/**
 * Host-attested local prompt configuration.
 *
 * A person edits ORIENTATION, CONSTITUTION, PARTNER or a World environment prompt in the settings
 * window. When the Host writes or explicitly confirms such a file, it records the canonical path,
 * content digest and time in a small metadata manifest under the deployment root. The Persona may
 * then map the exact text to `user-config` in the system prefix.
 *
 * The manifest stores no prompt text and is not a memory bank. It answers one narrow question:
 * "did the Host record this exact local file content after the person saved or confirmed it?"
 * It never claims the person said the words in conversation, and it does not make the text a
 * Hindsight source, an external fact or a World instruction. An edit, a reset, a replaced path or
 * a corrupt manifest makes the old record unusable.
 */
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export type PromptProvenanceKey = 'orientation' | 'constitution' | 'partner' | `worlds.${string}.envPrompt`;

export interface PromptProvenanceEntry {
  key: string;
  pathDigest: string;
  contentDigest: string;
  savedAt: string;
  writer: 'settings-ui';
  state: 'current' | 'revoked';
}

export interface PromptProvenanceFile {
  v: 1;
  scope: string;
  entries: PromptProvenanceEntry[];
}

export type PromptProvenanceRead =
  | { status: 'ok'; file: PromptProvenanceFile }
  | { status: 'missing' | 'invalid' | 'scope-mismatch' };

export interface PromptProvenanceConfig {
  rootDir: string;
  memoryDir: string;
  /** Defaults to `<rootDir>/prompt-provenance.json`. */
  file?: string;
}

export interface PromptVerification {
  ok: boolean;
  savedAt?: string;
  reason?: 'unconfigured' | 'missing' | 'invalid' | 'scope-mismatch' | 'not-attested' | 'revoked'
    | 'path-mismatch' | 'digest-mismatch' | 'unsafe-path' | 'too-large';
}

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BYTES = 2 * 1024 * 1024;
const KEY = /^(orientation|constitution|partner|worlds\.[a-z0-9][a-z0-9-]*\.envPrompt)$/;
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validEntry(value: unknown): value is PromptProvenanceEntry {
  return isRecord(value)
    && typeof value.key === 'string' && KEY.test(value.key)
    && typeof value.pathDigest === 'string' && SHA256.test(value.pathDigest)
    && typeof value.contentDigest === 'string' && SHA256.test(value.contentDigest)
    && typeof value.savedAt === 'string' && !!value.savedAt.trim() && !/[\r\n\0]/.test(value.savedAt)
    && value.writer === 'settings-ui'
    && (value.state === 'current' || value.state === 'revoked');
}

function parseFile(value: unknown): PromptProvenanceFile | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.scope !== 'string' || !SHA256.test(value.scope)
    || !Array.isArray(value.entries) || !value.entries.every(validEntry)) return null;
  const entries = value.entries as PromptProvenanceEntry[];
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) return null;
  return { v: 1, scope: value.scope, entries };
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\'));
}

function canonicalFile(file: string): string | null {
  try {
    if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !statSync(file).isFile()) return null;
    return realpathSync(file);
  } catch {
    return null;
  }
}

export class PromptProvenance {
  private config: PromptProvenanceConfig | null = null;
  private rootReal: string | null = null;

  configure(config: PromptProvenanceConfig): void {
    this.config = { ...config, file: config.file ?? join(config.rootDir, 'prompt-provenance.json') };
    this.rootReal = this.realDirectory(config.rootDir);
  }

  /** The exact allow-list of local files a prompt key may name. */
  private allowedPath(key: string): string | null {
    const config = this.config;
    if (!config) return null;
    if (key === 'orientation') return join(config.rootDir, 'prompts', 'ORIENTATION.md');
    if (key === 'constitution') return join(config.memoryDir, 'CONSTITUTION.md');
    if (key === 'partner') return join(config.memoryDir, 'PARTNER.md');
    const world = /^worlds\.([a-z0-9][a-z0-9-]*)\.envPrompt$/.exec(key);
    return world ? join(config.rootDir, 'worlds', world[1]!, 'ENV_PROMPT.md') : null;
  }

  private realDirectory(path: string): string | null {
    try { return realpathSync(path); } catch { return null; }
  }

  private safePath(key: string, file: string): string | null {
    const expected = this.allowedPath(key);
    if (!expected) return null;
    const target = canonicalFile(file);
    if (!target) return null;
    const expectedReal = canonicalFile(expected);
    if (!expectedReal || expectedReal !== target) return null;
    if (!this.rootReal || !inside(this.rootReal, target)) return null;
    return target;
  }

  private scope(): string | null {
    return this.rootReal ? sha256(this.rootReal) : null;
  }

  private file(): string | null {
    return this.config?.file ?? null;
  }

  read(): PromptProvenanceRead {
    const file = this.file();
    const scope = this.scope();
    if (!file || !scope) return { status: 'invalid' };
    if (!existsSync(file)) return { status: 'missing' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return { status: 'invalid' };
    }
    const manifest = parseFile(parsed);
    if (!manifest) return { status: 'invalid' };
    if (manifest.scope !== scope) return { status: 'scope-mismatch' };
    return { status: 'ok', file: manifest };
  }

  private loadForWrite(): PromptProvenanceFile | null {
    const scope = this.scope();
    const file = this.file();
    if (!scope || !file) return null;
    const read = this.read();
    if (read.status === 'ok') return read.file;
    if (read.status === 'missing') return { v: 1, scope, entries: [] };
    // A damaged manifest cannot authorize anything. Move it aside instead of silently extending it.
    try { renameSync(file, `${file}.invalid-${Date.now()}`); } catch { /* the write below still starts clean */ }
    return { v: 1, scope, entries: [] };
  }

  private write(manifest: PromptProvenanceFile): void {
    const file = this.file();
    if (!file) throw new Error('prompt provenance is not configured');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
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
    chmodSync(dirname(file), 0o700);
  }

  /**
   * Record the exact content the Host just wrote or the person just confirmed. Returns false for
   * a key, path or size outside the allow-list; it never creates an entry for an arbitrary file.
   */
  attest(input: { key: string; path: string; content: string; savedAt?: string }): boolean {
    if (!KEY.test(input.key) || Buffer.byteLength(input.content, 'utf8') > MAX_BYTES) return false;
    const real = this.safePath(input.key, input.path);
    if (!real) return false;
    const manifest = this.loadForWrite();
    if (!manifest) return false;
    const contentDigest = sha256(input.content);
    const pathDigest = sha256(real);
    const entry: PromptProvenanceEntry = {
      key: input.key,
      pathDigest,
      contentDigest,
      savedAt: input.savedAt ?? new Date().toISOString(),
      writer: 'settings-ui',
      state: 'current',
    };
    const entries = manifest.entries.filter((candidate) => candidate.key !== input.key);
    entries.push(entry);
    try {
      this.write({ ...manifest, entries });
      return true;
    } catch {
      return false;
    }
  }

  /** Revoke a key. The record stays for audit but can never verify again. */
  revoke(key: string): boolean {
    if (!KEY.test(key)) return false;
    const file = this.file();
    if (!file || !existsSync(file)) return true;
    const read = this.read();
    if (read.status !== 'ok') {
      try { rmSync(file, { force: true }); } catch { /* fail closed: absent is safer than damaged */ }
      return true;
    }
    const entries = read.file.entries.map((entry) => entry.key === key
      ? { ...entry, state: 'revoked' as const } : entry);
    try {
      this.write({ ...read.file, entries });
      return true;
    } catch {
      return false;
    }
  }

  /** Verify exact file content against a current Host record. Any doubt fails closed. */
  verify(input: { key: string; path: string; content: string }): PromptVerification {
    if (!this.config) return { ok: false, reason: 'unconfigured' };
    if (!KEY.test(input.key)) return { ok: false, reason: 'not-attested' };
    if (Buffer.byteLength(input.content, 'utf8') > MAX_BYTES) return { ok: false, reason: 'too-large' };
    const read = this.read();
    if (read.status !== 'ok') return { ok: false, reason: read.status };
    const real = this.safePath(input.key, input.path);
    if (!real) return { ok: false, reason: 'unsafe-path' };
    const entry = read.file.entries.find((candidate) => candidate.key === input.key);
    if (!entry) return { ok: false, reason: 'not-attested' };
    if (entry.state !== 'current') return { ok: false, reason: 'revoked' };
    if (entry.pathDigest !== sha256(real)) return { ok: false, reason: 'path-mismatch' };
    if (entry.contentDigest !== sha256(input.content)) return { ok: false, reason: 'digest-mismatch' };
    return { ok: true, savedAt: entry.savedAt };
  }

  /** World prompt verification by the exact template digest the prefix renderer read. */
  verifyWorldTemplate(worldId: string, path: string, templateDigest: string): boolean {
    const key = `worlds.${worldId}.envPrompt`;
    if (!KEY.test(key) || !SHA256.test(templateDigest)) return false;
    const read = this.read();
    if (read.status !== 'ok') return false;
    const entry = read.file.entries.find((candidate) => candidate.key === key);
    if (!entry || entry.state !== 'current') return false;
    const real = this.safePath(key, path);
    if (!real) return false;
    return entry.pathDigest === sha256(real) && entry.contentDigest === templateDigest;
  }
}
