/**
 * Durable permission for the Persona workspace writes Coo does while nobody is watching.
 *
 * Core owns this file. A World, a model or a tool result can ask for a write, but only a rule the
 * person created from the settings panel or from the confirmation bubble can make it automatic.
 * Every automatic write still goes through the ActionGate, the receipt ledger and the read-back
 * check; this module decides only whether the person has already agreed to that class of write.
 *
 * The store fails closed. A missing, unreadable or invalid rule file disables automatic writes
 * instead of rebuilding a wider policy from defaults.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { asRecord, field, InvalidState, readState, writeState } from './state-file.ts';

export type WorkspaceWriteOperation = 'create' | 'append' | 'update' | 'delete';
export type WorkspaceDecision = 'AUTO_ALLOW' | 'REQUIRE_APPROVAL' | 'DENY' | 'DEFER';
export type WorkspaceApprovalChannel = 'durable-rule' | 'core-pet-bubble' | 'permission-center';
export type WorkspacePromptAnswer = 'yes' | 'always' | 'no' | 'timeout' | 'unavailable';
export type WorkspacePendingStatus = 'pending' | 'deferred' | 'approved-once' | 'denied';

/** A rule names one exact file or one directory prefix inside the Persona workspace. */
export interface WorkspaceWriteRule {
  id: string;
  /** `self-review/` for a directory, `mind/now.md` for one file. */
  path: string;
  operations: Array<'create' | 'append' | 'update'>;
  extensions: string[];
  maxBytes: number;
  createdAt: number;
  createdBy: 'owner-settings' | 'owner-prompt';
  note?: string;
}

export interface WorkspaceWriteInput {
  workspaceRoot: string;
  /** Canonical absolute path the tool will write, already checked by the Persona tool. */
  absolutePath: string;
  /** Workspace-relative path with `/` separators. */
  path: string;
  tool: string;
  operation: WorkspaceWriteOperation;
  targetState: 'absent' | 'present';
  /** SHA-256 of the file before the write, null when absent. */
  baseDigest: string | null;
  payloadDigest: string;
  /** The bytes the write will add or replace; append uses only the appended part. */
  payloadBytes: number;
  deltaBytes: number;
  mime: string;
  source: string;
  taskId: string;
  sessionId: string;
  /** True for a self-time or Growth turn, where no person is expected to answer a bubble. */
  background: boolean;
}

export interface WorkspacePolicyResult {
  decision: WorkspaceDecision;
  /** A stable code, safe to log; never file content. */
  reason: string;
  ruleId?: string;
  pendingId?: string;
}

export interface WorkspaceApprovalResult extends Omit<WorkspacePolicyResult, 'decision'> {
  decision: 'AUTO_ALLOW' | 'DENY' | 'DEFER';
  channel?: WorkspaceApprovalChannel;
}

export interface WorkspacePromptRequest {
  path: string;
  operation: WorkspaceWriteOperation;
  bytes: number;
  digest: string;
  /** `self-review/` or `mind/now.md`; what an "always" answer would cover. */
  scope: string;
  /** False for delete, protected names, non-data files and other high-impact requests. */
  ruleEligible: boolean;
}

export type WorkspacePrompt = (request: WorkspacePromptRequest) => Promise<WorkspacePromptAnswer>;

export interface WorkspacePendingView {
  id: string;
  path: string;
  operation: WorkspaceWriteOperation;
  tool: string;
  bytes: number;
  payloadDigest: string;
  targetState: 'absent' | 'present';
  status: WorkspacePendingStatus;
  attempts: number;
  createdAt: number;
  lastSeenAt: number;
  lastPromptAt?: number;
  holdUntil?: number;
  expiresAt?: number;
  ruleEligible: boolean;
  scope: string;
  /** Why the last decision required a person. */
  reason: string;
}

export interface WorkspacePermissionView {
  available: boolean;
  paused: boolean;
  degraded: boolean;
  rules: WorkspaceWriteRule[];
  pending: WorkspacePendingView[];
  pendingCount: number;
  usage: { day: string; writes: number; bytes: number; maxWrites: number; maxBytes: number };
  limits: {
    maxAutoBytes: number;
    maxAutoAppendBytes: number;
    dailyWrites: number;
    dailyBytes: number;
    promptCooldownMs: number;
    deferHoldMs: number;
  };
}

interface PendingRecord extends WorkspacePendingView {
  key: string;
  workspaceRoot: string;
  baseDigest: string | null;
  mime: string;
  sessionId: string;
  lastNotifiedAt?: number;
}

interface PermissionState {
  v: 1;
  paused: boolean;
  rules: WorkspaceWriteRule[];
  pending: PendingRecord[];
  usage: { day: string; writes: number; bytes: number };
  lastNotifiedAt?: number;
}

export interface WorkspacePermissionStoreOptions {
  file: string;
  timezone?: () => string;
  now?: () => number;
  /** Called once when a new request starts waiting; the app turns it into one system notification. */
  onPending?: (pending: { count: number; path: string; operation: WorkspaceWriteOperation }) => void;
}

const MAX_AUTO_BYTES = 64 * 1024;
const MAX_AUTO_APPEND_BYTES = 24 * 1024;
const DAILY_WRITES = 200;
const DAILY_BYTES = 2 * 1024 * 1024;
const MAX_RULES = 32;
const MAX_PENDING = 50;
const MAX_HISTORY = 200;
const PROMPT_COOLDOWN_MS = 10 * 60_000;
const DEFER_HOLD_MS = 6 * 60 * 60_000;
const ONE_SHOT_TTL_MS = 10 * 60_000;
const PER_PATH_INTERVAL_MS = 1_500;
const MAX_PATH_BYTES = 1_024;
const MAX_PATH_DEPTH = 6;
const MAX_FILE_NAME_BYTES = 200;
const OPERATIONS = new Set<WorkspaceWriteOperation>(['create', 'append', 'update', 'delete']);
const AUTO_OPERATIONS = new Set<'create' | 'append' | 'update'>(['create', 'append', 'update']);
const EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl']);
const PROTECTED_NAMES = new Set([
  'constitution.md', 'self.md', 'self.history.md', 'partner.md', 'agents.md', 'philosophy.md',
  'claude.md', 'package.json', 'tsconfig.json', 'config.json', 'settings.json', 'credentials.json',
  'secrets.json', 'id_rsa', 'id_ed25519',
]);
const PROTECTED_PREFIXES = ['partner/', 'handoffs/', 'prompts/', 'worlds/', 'providers/', 'runtimes/', 'avatars/', 'blobs/', '.git/'];
const SCRATCH_EXTENSION = /\.(?:env|sqlite3?|db|db-wal|db-shm|wal|shm|key|pem|p12|pfx|sh|zsh|bash|command|app|js|mjs|cjs|ts|tsx|jsx|py|rb|pl|php|jar|exe|dll|dylib|so|bin|wasm|html?|svg|xml|ya?ml|toml|ini|conf|cfg|lock|zip|tar|gz|7z|dmg|pkg)$/i;
const UNSAFE_NAME = /[\u0000-\u001f<>:"|?*\\]/;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Suggested directories for the settings panel's one-click low-risk policy. */
export const DEFAULT_LOW_RISK_RULES: ReadonlyArray<Pick<WorkspaceWriteRule, 'path' | 'operations' | 'extensions' | 'maxBytes'>> = [
  { path: 'self-review/', operations: ['create', 'append', 'update'], extensions: ['.md', '.txt', '.json'], maxBytes: MAX_AUTO_BYTES },
  { path: 'journal/', operations: ['create', 'append', 'update'], extensions: ['.md', '.txt', '.json'], maxBytes: MAX_AUTO_BYTES },
  { path: 'mind/', operations: ['create', 'append', 'update'], extensions: ['.md', '.txt', '.json', '.jsonl'], maxBytes: MAX_AUTO_BYTES },
  { path: 'lab/', operations: ['create', 'append', 'update'], extensions: ['.md', '.txt', '.json'], maxBytes: MAX_AUTO_BYTES },
  { path: 'agenda/', operations: ['create', 'append', 'update'], extensions: ['.md', '.txt'], maxBytes: MAX_AUTO_BYTES },
];

const isString = (value: unknown): value is string => typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const localDay = (timezone: string, now: number): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
};

/** Rejects names that leave the workspace, hide from listings, or name system files. */
export function inspectWorkspacePath(root: string, path: string): { ok: true; absolutePath: string; relativePath: string } | { ok: false; reason: string } {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, reason: 'empty-path' };
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) return { ok: false, reason: 'path-too-long' };
  if (path.includes('\0') || path.includes('\\')) return { ok: false, reason: 'path-character' };
  if (path.startsWith('/') || isAbsolute(path)) return { ok: false, reason: 'absolute-path' };
  const segments = path.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) return { ok: false, reason: 'path-segment' };
  if (segments.length > MAX_PATH_DEPTH) return { ok: false, reason: 'path-depth' };
  if (segments.some((part) => part.startsWith('.') || UNSAFE_NAME.test(part))) return { ok: false, reason: 'path-hidden-or-unsafe' };
  const name = segments.at(-1) ?? '';
  if (Buffer.byteLength(name, 'utf8') > MAX_FILE_NAME_BYTES) return { ok: false, reason: 'name-too-long' };
  if (/[. ]$/.test(name)) return { ok: false, reason: 'name-trailing' };
  const normalized = path.normalize('NFC');
  const lower = normalized.toLowerCase();
  const leaf = basename(lower);
  if (PROTECTED_NAMES.has(leaf) || SCRATCH_EXTENSION.test(leaf)) return { ok: false, reason: 'protected-name' };
  if (PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return { ok: false, reason: 'protected-directory' };
  if (!EXTENSIONS.has(extname(leaf))) return { ok: false, reason: 'extension' };

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, reason: 'root-unavailable' };
  }
  const absolutePath = resolve(realRoot, ...segments);
  const rel = relative(realRoot, absolutePath).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel === '..' || isAbsolute(rel)) return { ok: false, reason: 'outside-root' };

  // Every existing component must be a real directory or the final regular file. A symlink in the
  // path can point outside the workspace even when the lexical path looks safe.
  let cursor = realRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment);
    const last = index === segments.length - 1;
    let info;
    try {
      info = lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, absolutePath, relativePath: rel };
      return { ok: false, reason: 'path-unreadable' };
    }
    if (info.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (!last && !info.isDirectory()) return { ok: false, reason: 'parent-not-directory' };
    if (last && !info.isFile()) return { ok: false, reason: 'not-a-regular-file' };
    if (last && statSync(cursor).nlink > 1) return { ok: false, reason: 'hardlink' };
  }
  return { ok: true, absolutePath, relativePath: rel };
}

/** The directory an "always" answer would cover, or the exact file when it has no safe parent. */
export function ruleScopeFor(path: string): string {
  const segments = path.split('/');
  return segments.length > 1 ? `${segments[0]}/` : path;
}

export function ruleMatchesPath(rule: WorkspaceWriteRule, path: string): boolean {
  return rule.path.endsWith('/') ? path.startsWith(rule.path) : path === rule.path;
}

export function normalizeRule(input: Partial<WorkspaceWriteRule>, now = Date.now(), createdBy: WorkspaceWriteRule['createdBy'] = 'owner-settings'): WorkspaceWriteRule | { error: string } {
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (!path) return { error: 'path-empty' };
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return { error: 'path-invalid' };
  const directory = path.endsWith('/');
  const inspected = inspectWorkspacePathSample(path);
  if (!inspected) return { error: 'path-protected' };
  const operations = [...new Set(input.operations ?? [])].filter((operation): operation is 'create' | 'append' | 'update' =>
    AUTO_OPERATIONS.has(operation as 'create' | 'append' | 'update'));
  if (!operations.length) return { error: 'operations-empty' };
  const extensions = [...new Set(input.extensions ?? [...EXTENSIONS])].filter((extension) => EXTENSIONS.has(extension));
  if (!extensions.length) return { error: 'extensions-empty' };
  const maxBytes = input.maxBytes ?? MAX_AUTO_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_AUTO_BYTES) return { error: 'max-bytes' };
  return {
    id: typeof input.id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(input.id) ? input.id : randomUUID(),
    path: directory ? path : path,
    operations,
    extensions,
    maxBytes,
    createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : now,
    createdBy,
    ...(typeof input.note === 'string' && input.note.trim() ? { note: input.note.trim().slice(0, 120) } : {}),
  };
}

/** Path-shape check for a rule that may name a directory; it need not exist yet. */
function inspectWorkspacePathSample(path: string): boolean {
  const directory = path.endsWith('/');
  const probe = directory ? `${path}probe.md` : path;
  const segments = probe.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false;
  const lower = probe.toLowerCase();
  if (PROTECTED_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  const leaf = basename(lower);
  if (PROTECTED_NAMES.has(leaf) || SCRATCH_EXTENSION.test(leaf)) return false;
  return directory || EXTENSIONS.has(extname(leaf));
}

/**
 * Durable rules, the pending queue and the daily quota.
 *
 * Reads are synchronous and side-effect free. `authorize` is the only method that may prompt or
 * change the queue; it is called from the Core write path, never from a World.
 */
export class WorkspacePermissionStore {
  private state: PermissionState;
  private degraded = false;
  private prompting = false;
  private readonly now: () => number;
  private readonly timezone: () => string;
  private readonly recent = new Map<string, number>();
  private lastNotifiedAt = 0;

  constructor(private readonly opts: WorkspacePermissionStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.timezone = opts.timezone ?? (() => 'UTC');
    try { mkdirSync(dirname(opts.file), { recursive: true }); } catch { this.degraded = true; }
    this.state = this.load();
    this.lastNotifiedAt = this.state.lastNotifiedAt ?? 0;
  }

  /** Changes to any rule, pause state or store health invalidate pending grants. */
  generation(): string {
    return hash([this.state.paused, this.degraded, this.state.rules.map((rule) => [rule.id, rule.path, rule.operations, rule.extensions, rule.maxBytes])]);
  }

  snapshot(): WorkspacePermissionView {
    this.rollUsage();
    const pending = this.activePending().map((record) => this.view(record));
    return {
      available: true,
      paused: this.state.paused,
      degraded: this.degraded,
      rules: structuredClone(this.state.rules),
      pending,
      pendingCount: pending.length,
      usage: {
        day: this.state.usage.day,
        writes: this.state.usage.writes,
        bytes: this.state.usage.bytes,
        maxWrites: DAILY_WRITES,
        maxBytes: DAILY_BYTES,
      },
      limits: {
        maxAutoBytes: MAX_AUTO_BYTES,
        maxAutoAppendBytes: MAX_AUTO_APPEND_BYTES,
        dailyWrites: DAILY_WRITES,
        dailyBytes: DAILY_BYTES,
        promptCooldownMs: PROMPT_COOLDOWN_MS,
        deferHoldMs: DEFER_HOLD_MS,
      },
    };
  }

  /** Pure policy evaluation; pending state and interactive approval are handled by `authorize`. */
  evaluate(input: WorkspaceWriteInput): WorkspacePolicyResult {
    if (this.degraded) return { decision: 'DENY', reason: 'store-degraded' };
    if (this.state.paused) return { decision: 'DEFER', reason: 'paused' };
    if (resolve(input.workspaceRoot, ...input.path.split('/')) !== resolve(input.absolutePath)) return { decision: 'DENY', reason: 'target-mismatch' };
    const inspected = inspectWorkspacePath(input.workspaceRoot, input.path);
    if (!inspected.ok) return { decision: 'DENY', reason: inspected.reason };
    if (!OPERATIONS.has(input.operation)) return { decision: 'DENY', reason: 'operation-unknown' };
    if (input.operation === 'delete') return { decision: 'REQUIRE_APPROVAL', reason: 'delete' };
    if (input.targetState === 'present' && input.baseDigest === null) return { decision: 'DENY', reason: 'missing-base-digest' };
    if (input.targetState === 'absent' && input.baseDigest !== null) return { decision: 'DENY', reason: 'unexpected-base-digest' };
    if (!/^[a-f0-9]{64}$/.test(input.payloadDigest)) return { decision: 'DENY', reason: 'payload-digest' };
    if (!Number.isSafeInteger(input.payloadBytes) || input.payloadBytes < 0) return { decision: 'DENY', reason: 'payload-bytes' };
    if (!/^text\//.test(input.mime) && input.mime !== 'application/json' && input.mime !== 'application/x-ndjson') {
      return { decision: 'REQUIRE_APPROVAL', reason: 'mime' };
    }
    if (input.payloadBytes > MAX_AUTO_BYTES) return { decision: 'REQUIRE_APPROVAL', reason: 'file-too-large' };
    if (input.operation === 'append' && input.deltaBytes > MAX_AUTO_APPEND_BYTES) {
      return { decision: 'REQUIRE_APPROVAL', reason: 'append-too-large' };
    }

    this.rollUsage(false);
    if (this.state.usage.writes >= DAILY_WRITES) return { decision: 'REQUIRE_APPROVAL', reason: 'daily-writes' };
    if (this.state.usage.bytes + input.payloadBytes > DAILY_BYTES) return { decision: 'REQUIRE_APPROVAL', reason: 'daily-bytes' };
    const last = this.recent.get(`${input.workspaceRoot}\0${input.path}`) ?? 0;
    if (this.now() - last < PER_PATH_INTERVAL_MS) return { decision: 'DEFER', reason: 'rate-limit' };

    const rule = this.matchingRule(input.path);
    if (!rule) return { decision: 'REQUIRE_APPROVAL', reason: 'no-rule' };
    if (!rule.operations.includes(input.operation)) return { decision: 'REQUIRE_APPROVAL', reason: 'rule-operation' };
    if (!rule.extensions.includes(extname(input.path).toLowerCase())) return { decision: 'REQUIRE_APPROVAL', reason: 'rule-extension' };
    if (input.payloadBytes > rule.maxBytes) return { decision: 'REQUIRE_APPROVAL', reason: 'rule-size' };
    if (input.operation === 'create' && input.targetState !== 'absent') return { decision: 'REQUIRE_APPROVAL', reason: 'create-existing' };
    if (input.operation === 'update' && input.targetState !== 'present') return { decision: 'REQUIRE_APPROVAL', reason: 'update-absent' };
    if (input.operation === 'append' && input.targetState === 'absent' && !rule.operations.includes('create')) {
      return { decision: 'REQUIRE_APPROVAL', reason: 'append-creates-file' };
    }
    return { decision: 'AUTO_ALLOW', reason: 'rule-match', ruleId: rule.id };
  }

  /**
   * The one entry point for a write request. Automatic rules skip the bubble; a request that still
   * needs a person is coalesced by path and operation, shown at most once per cooldown, and never
   * prompted from a background turn.
   */
  async authorize(input: WorkspaceWriteInput, prompt: WorkspacePrompt): Promise<WorkspaceApprovalResult> {
    const now = this.now();
    this.rollUsage();
    const evaluated = this.evaluate(input);
    if (evaluated.decision === 'AUTO_ALLOW') {
      this.recordWrite(input);
      return { decision: 'AUTO_ALLOW', reason: evaluated.reason, ...(evaluated.ruleId ? { ruleId: evaluated.ruleId } : {}), channel: 'durable-rule' };
    }
    if (evaluated.decision === 'DENY') {
      return { decision: 'DENY', reason: evaluated.reason };
    }
    if (evaluated.decision === 'DEFER') {
      return { decision: 'DEFER', reason: evaluated.reason };
    }

    const key = hash(['workspace', input.workspaceRoot, input.path, input.operation]);
    const existing = this.state.pending.find((record) => record.key === key);
    if (existing?.status === 'approved-once') {
      if (existing.payloadDigest === input.payloadDigest && (existing.expiresAt ?? 0) > now) {
        this.state.pending = this.state.pending.filter((record) => record.id !== existing.id);
        this.recordWrite(input);
        this.save();
        return { decision: 'AUTO_ALLOW', reason: 'permission-center-once', channel: 'permission-center' };
      }
      existing.status = 'pending';
      existing.expiresAt = undefined;
      existing.reason = existing.payloadDigest === input.payloadDigest ? 'approval-expired' : 'content-changed';
    }
    if (existing?.status === 'denied' && (existing.holdUntil ?? 0) > now) {
      this.touch(existing, input, now);
      return { decision: 'DENY', reason: 'owner-declined', pendingId: existing.id };
    }
    // A settled hold expires into a fresh request; the person can always act from the panel.
    if (existing?.status === 'deferred' && (existing.holdUntil ?? 0) > now) {
      this.touch(existing, input, now);
      return { decision: 'DEFER', reason: 'waiting-for-approval', pendingId: existing.id };
    }

    const scope = ruleScopeFor(input.path);
    const ruleEligible = this.isRuleScopeEligible(scope);
    const record = existing ?? this.newPending(input, key, now, scope, ruleEligible);
    record.status = 'pending';
    record.reason = evaluated.reason;
    record.holdUntil = undefined;
    record.baseDigest = input.baseDigest;
    record.mime = input.mime;
    record.sessionId = input.sessionId;
    this.touch(record, input, now, scope, ruleEligible);
    this.save();

    if (input.background) {
      record.status = 'deferred';
      record.holdUntil = now + DEFER_HOLD_MS;
      this.save();
      this.notify(record, now, true);
      return { decision: 'DEFER', reason: 'background-waiting-for-approval', pendingId: record.id };
    }

    const promptAllowed = !this.prompting && (record.lastPromptAt ?? 0) + PROMPT_COOLDOWN_MS <= now;
    if (!promptAllowed) {
      record.status = 'deferred';
      record.holdUntil = now + DEFER_HOLD_MS;
      this.save();
      return { decision: 'DEFER', reason: 'prompt-cooldown', pendingId: record.id };
    }

    this.prompting = true;
    record.lastPromptAt = now;
    this.save();
    let answer: WorkspacePromptAnswer = 'unavailable';
    try {
      answer = await prompt({
        path: input.path,
        operation: input.operation,
        bytes: input.payloadBytes,
        digest: input.payloadDigest,
        scope,
        ruleEligible,
      });
    } catch {
      answer = 'unavailable';
    } finally {
      this.prompting = false;
    }

    if (answer === 'yes' || (answer === 'always' && ruleEligible)) {
      let ruleId: string | undefined;
      if (answer === 'always') {
        const granted = this.grantRule({ path: scope, operations: ['create', 'append', 'update'], extensions: [...EXTENSIONS], maxBytes: MAX_AUTO_BYTES }, 'owner-prompt');
        if (granted.ok) ruleId = granted.rule.id;
      }
      this.state.pending = this.state.pending.filter((candidate) => candidate.id !== record.id);
      this.recordWrite(input);
      this.save();
      return {
        decision: 'AUTO_ALLOW',
        reason: answer === 'always' && ruleId ? 'owner-always' : 'owner-once',
        channel: ruleId ? 'durable-rule' : 'core-pet-bubble',
        ...(ruleId ? { ruleId } : {}),
      };
    }
    if (answer === 'no') {
      record.status = 'denied';
      record.holdUntil = now + DEFER_HOLD_MS;
      this.save();
      return { decision: 'DENY', reason: 'owner-declined', pendingId: record.id };
    }
    record.status = 'deferred';
    record.holdUntil = now + DEFER_HOLD_MS;
    this.save();
    this.notify(record, now, false);
    return { decision: 'DEFER', reason: `prompt-${answer}`, pendingId: record.id };
  }

  grantRule(input: Partial<WorkspaceWriteRule>, createdBy: WorkspaceWriteRule['createdBy'] = 'owner-settings'): { ok: true; rule: WorkspaceWriteRule } | { ok: false; error: string } {
    const normalized = normalizeRule(input, this.now(), createdBy);
    if ('error' in normalized) return { ok: false, error: normalized.error };
    const duplicate = this.state.rules.find((rule) => rule.path === normalized.path);
    if (duplicate) {
      Object.assign(duplicate, { operations: normalized.operations, extensions: normalized.extensions, maxBytes: normalized.maxBytes, note: normalized.note });
      this.degraded = false;
      this.save();
      return { ok: true, rule: structuredClone(duplicate) };
    }
    if (this.state.rules.length >= MAX_RULES) return { ok: false, error: 'too-many-rules' };
    this.state.rules.push(normalized);
    this.degraded = false;
    this.save();
    return { ok: true, rule: structuredClone(normalized) };
  }

  enableDefaults(): { ok: true; added: number } {
    let added = 0;
    for (const rule of DEFAULT_LOW_RISK_RULES) {
      if (this.state.rules.some((existing) => existing.path === rule.path)) continue;
      const result = this.grantRule(rule, 'owner-settings');
      if (result.ok) added += 1;
    }
    return { ok: true, added };
  }

  revokeRule(id: string): boolean {
    const before = this.state.rules.length;
    this.state.rules = this.state.rules.filter((rule) => rule.id !== id);
    if (this.state.rules.length === before) return false;
    this.save();
    return true;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
    this.save();
  }

  /** The settings panel's actions; never reachable from a model tool. */
  resolvePending(id: string, action: 'allow-once' | 'always' | 'deny' | 'dismiss'): { ok: true } | { ok: false; error: string } {
    const record = this.state.pending.find((candidate) => candidate.id === id);
    if (!record) return { ok: false, error: 'missing' };
    const now = this.now();
    if (action === 'allow-once') {
      record.status = 'approved-once';
      record.expiresAt = now + ONE_SHOT_TTL_MS;
      record.holdUntil = undefined;
    } else if (action === 'always') {
      const granted = this.grantRule({
        path: record.scope,
        operations: ['create', 'append', 'update'],
        extensions: [...EXTENSIONS],
        maxBytes: MAX_AUTO_BYTES,
      }, 'owner-settings');
      if (!granted.ok) return { ok: false, error: granted.error };
      this.state.pending = this.state.pending.filter((candidate) => candidate.id !== id);
    } else if (action === 'deny') {
      record.status = 'denied';
      record.holdUntil = now + DEFER_HOLD_MS;
    } else {
      this.state.pending = this.state.pending.filter((candidate) => candidate.id !== id);
    }
    this.save();
    return { ok: true };
  }

  clearSettled(olderThanMs = 24 * 60 * 60_000): number {
    const before = this.state.pending.length;
    const cutoff = this.now() - olderThanMs;
    this.state.pending = this.state.pending.filter((record) =>
      !(record.status === 'denied' && (record.holdUntil ?? 0) <= this.now())
      && !(record.status === 'approved-once' && (record.expiresAt ?? 0) <= cutoff));
    if (this.state.pending.length !== before) this.save();
    return before - this.state.pending.length;
  }

  private matchingRule(path: string): WorkspaceWriteRule | null {
    const matches = this.state.rules.filter((rule) => ruleMatchesPath(rule, path));
    if (!matches.length) return null;
    // The most specific rule wins, so a file rule can narrow a directory rule.
    return matches.sort((a, b) => b.path.length - a.path.length)[0] ?? null;
  }

  private isRuleScopeEligible(scope: string): boolean {
    return !('error' in normalizeRule({
      path: scope,
      operations: ['create', 'append', 'update'],
      extensions: [...EXTENSIONS],
      maxBytes: MAX_AUTO_BYTES,
    }, this.now()));
  }

  private newPending(input: WorkspaceWriteInput, key: string, now: number, scope: string, ruleEligible: boolean): PendingRecord {
    const record: PendingRecord = {
      id: randomUUID(),
      key,
      workspaceRoot: input.workspaceRoot,
      baseDigest: input.baseDigest,
      mime: input.mime,
      sessionId: input.sessionId,
      path: input.path,
      operation: input.operation,
      tool: input.tool,
      bytes: input.payloadBytes,
      payloadDigest: input.payloadDigest,
      targetState: input.targetState,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      lastSeenAt: now,
      ruleEligible,
      scope,
      reason: 'no-rule',
    };
    this.state.pending.push(record);
    if (this.state.pending.length > MAX_PENDING) {
      const keep = this.activePending().slice(-MAX_PENDING);
      const keepIds = new Set(keep.map((candidate) => candidate.id));
      this.state.pending = this.state.pending.filter((candidate) => keepIds.has(candidate.id));
    }
    return record;
  }

  private touch(record: PendingRecord, input: WorkspaceWriteInput, now: number, scope = record.scope, ruleEligible = record.ruleEligible): void {
    record.lastSeenAt = now;
    record.attempts += 1;
    record.bytes = input.payloadBytes;
    record.payloadDigest = input.payloadDigest;
    record.tool = input.tool;
    record.targetState = input.targetState;
    record.baseDigest = input.baseDigest;
    record.sessionId = input.sessionId;
    record.scope = scope;
    record.ruleEligible = ruleEligible;
  }

  private recordWrite(input: WorkspaceWriteInput): void {
    this.rollUsage();
    this.state.usage.writes += 1;
    this.state.usage.bytes += input.payloadBytes;
    this.recent.set(`${input.workspaceRoot}\0${input.path}`, this.now());
    if (this.recent.size > 400) {
      const cutoff = this.now() - 10 * 60_000;
      for (const [key, at] of this.recent) if (at < cutoff) this.recent.delete(key);
    }
  }

  private notify(record: PendingRecord, now: number, first: boolean): void {
    if (!first && (record.lastNotifiedAt ?? 0) + DEFER_HOLD_MS > now) return;
    if (this.lastNotifiedAt + DEFER_HOLD_MS > now) return;
    this.lastNotifiedAt = now;
    record.lastNotifiedAt = now;
    this.state.lastNotifiedAt = now;
    this.save();
    try {
      this.opts.onPending?.({ count: this.activePending().length, path: record.path, operation: record.operation });
    } catch {
      // A failed desktop notification must not change the decision.
    }
  }

  private activePending(): PendingRecord[] {
    const now = this.now();
    return this.state.pending.filter((record) => {
      if (record.status === 'approved-once') return (record.expiresAt ?? 0) > now;
      if (record.status === 'denied') return false;
      if (record.status === 'deferred') return (record.holdUntil ?? 0) > now;
      return true;
    });
  }

  private view(record: PendingRecord): WorkspacePendingView {
    const { key: _key, workspaceRoot: _root, baseDigest: _base, mime: _mime, sessionId: _session, lastNotifiedAt: _notified, ...view } = record;
    return structuredClone(view);
  }

  private rollUsage(persist = true): void {
    const day = localDay(this.timezone(), this.now());
    if (this.state.usage.day === day) return;
    this.state.usage = { day, writes: 0, bytes: 0 };
    if (persist) this.save();
  }

  private load(): PermissionState {
    const existed = existsSync(this.opts.file);
    let restored: PermissionState | null = null;
    try {
      restored = readState(this.opts.file, (value) => this.restore(value));
    } catch {
      this.degraded = true;
    }
    if (existed && !restored) this.degraded = true;
    return restored ?? {
      v: 1,
      paused: false,
      rules: [],
      pending: [],
      usage: { day: localDay(this.timezone(), this.now()), writes: 0, bytes: 0 },
    };
  }

  private restore(value: unknown): PermissionState {
    const record = asRecord(value);
    const version = field(record, 'v', (v): v is 1 => v === 1);
    if (version !== 1) throw new InvalidState('unsupported permission version');
    const paused = field(record, 'paused', (v): v is boolean => typeof v === 'boolean');
    const rawRules = field(record, 'rules', (v): v is unknown[] => Array.isArray(v));
    const rawPending = field(record, 'pending', (v): v is unknown[] => Array.isArray(v));
    const usage = field(record, 'usage', (v): v is Record<string, unknown> => isRecord(v));
    const rules: WorkspaceWriteRule[] = [];
    for (const raw of rawRules) {
      if (!isRecord(raw)) throw new InvalidState('rule is not an object');
      const path = field(raw, 'path', isString);
      const operations = field(raw, 'operations', (v): v is unknown[] => Array.isArray(v));
      const extensions = field(raw, 'extensions', (v): v is unknown[] => Array.isArray(v));
      const normalized = normalizeRule({
        id: field(raw, 'id', isString),
        path,
        operations: operations.filter(isString) as WorkspaceWriteRule['operations'],
        extensions: extensions.filter(isString),
        maxBytes: field(raw, 'maxBytes', isCount),
        createdAt: field(raw, 'createdAt', isCount),
        note: raw.note === undefined ? undefined : field(raw, 'note', isString),
      }, this.now(), field(raw, 'createdBy', (v): v is WorkspaceWriteRule['createdBy'] => v === 'owner-settings' || v === 'owner-prompt'));
      if ('error' in normalized) throw new InvalidState(`rule rejected: ${normalized.error}`);
      rules.push(normalized);
    }
    const pending: PendingRecord[] = [];
    for (const raw of rawPending) {
      if (!isRecord(raw)) throw new InvalidState('pending is not an object');
      const status = field(raw, 'status', (v): v is WorkspacePendingStatus => v === 'pending' || v === 'deferred' || v === 'approved-once' || v === 'denied');
      const operation = field(raw, 'operation', (v): v is WorkspaceWriteOperation => v === 'create' || v === 'append' || v === 'update' || v === 'delete');
      pending.push({
        id: field(raw, 'id', isString),
        key: field(raw, 'key', isString),
        workspaceRoot: field(raw, 'workspaceRoot', isString),
        baseDigest: raw.baseDigest === null ? null : field(raw, 'baseDigest', isString),
        mime: field(raw, 'mime', isString),
        sessionId: field(raw, 'sessionId', isString),
        path: field(raw, 'path', isString),
        operation,
        tool: field(raw, 'tool', isString),
        bytes: field(raw, 'bytes', isCount),
        payloadDigest: field(raw, 'payloadDigest', isString),
        targetState: field(raw, 'targetState', (v): v is 'absent' | 'present' => v === 'absent' || v === 'present'),
        status,
        attempts: field(raw, 'attempts', isCount),
        createdAt: field(raw, 'createdAt', isCount),
        lastSeenAt: field(raw, 'lastSeenAt', isCount),
        ...(raw.lastPromptAt === undefined ? {} : { lastPromptAt: field(raw, 'lastPromptAt', isCount) }),
        ...(raw.holdUntil === undefined ? {} : { holdUntil: field(raw, 'holdUntil', isCount) }),
        ...(raw.expiresAt === undefined ? {} : { expiresAt: field(raw, 'expiresAt', isCount) }),
        ruleEligible: field(raw, 'ruleEligible', (v): v is boolean => typeof v === 'boolean'),
        scope: field(raw, 'scope', isString),
        reason: field(raw, 'reason', isString),
        ...(raw.lastNotifiedAt === undefined ? {} : { lastNotifiedAt: field(raw, 'lastNotifiedAt', isCount) }),
      });
    }
    return {
      v: 1,
      paused,
      rules,
      pending,
      usage: {
        day: field(usage, 'day', isString),
        writes: field(usage, 'writes', isCount),
        bytes: field(usage, 'bytes', isCount),
      },
      ...(record.lastNotifiedAt === undefined ? {} : { lastNotifiedAt: field(record, 'lastNotifiedAt', isCount) }),
    };
  }

  private save(): void {
    try {
      writeState(this.opts.file, `${JSON.stringify(this.state, null, 2)}\n`);
    } catch {
      // An unwritable store must stop automatic writes rather than keep the in-memory rule alive.
      this.degraded = true;
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
