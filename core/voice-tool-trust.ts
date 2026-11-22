/**
 * Production trust for exactly two local voice tools: `tts_speak` and `audio_play`.
 *
 * The Owner approved these two schemas, their packages and their sources in Rev29 §0W. This module
 * turns that approval into a check the Host performs at startup, and keeps the two Worlds on a short
 * leash while they run:
 *
 * 1. **Exact identity.** The installed package directory, its `package.json` version, the reviewed
 *    source file's SHA-256 and the schema digest of the tool the World actually declares must all
 *    equal `VOICE_TOOL_SCHEMA_ROOTS`. Anything else fails closed: the digest is not added to the
 *    request's trust set and the tool is never visible to the model.
 * 2. **Tool-level exposure.** The World is wrapped so `tools()` returns only `exposes`
 *    (`tts_speak`, `audio_play`). `tts_control` and `audio_watch` are never registered, even though
 *    they live in the same packages, so sharing a World cannot grant them production identity or an
 *    execution path.
 * 3. **Who executes.** A digest list alone cannot tell two Worlds apart. The wrapper marks the one
 *    instance it made, and the audit only trusts a mounted World that carries that mark and whose id
 *    is the approved one. If any other mounted World declares a tool with a voice digest, the digest
 *    is dropped and the mismatch is logged.
 * 4. **Request scope.** The wrapped handlers refuse what this round did not authorize: a TTS
 *    endpoint that is not loopback, a voice other than the configured one, asynchronous delivery,
 *    `file:`/`mem:`/relative audio references and audio outside the controlled clip directory.
 *
 * Trust here is about the tool definition and the execution target only; it does not grant any
 * permission. Receipts, source proofs and the rest of the evidence path are unchanged.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { toolSchemaDigest } from 'cortico/core/evidence.ts';
import type { ToolDef, ToolOutcome, World } from 'cortico/core/types.ts';
import type { WorldDefinition, WorldSection } from 'cortico/world.ts';
import { VOICE_TOOL_SCHEMA_ROOTS, type VoiceToolSchemaRoot } from './tool-schema-roots.ts';

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** The mark the wrapped instance carries; the audit refuses a World without it. */
const GRANT = Symbol('coopanion.voice-tool-grant');
/** The mark a receipt gets only when the granted wrapper produced it. */
const RECEIPT = Symbol.for('coopanion.voice-tool-receipt');

type VoiceLog = { warn(message: string, data?: unknown): void };

export interface VoiceTrustOptions {
  /** Absolute path of the extensions directory the running process loads packages from. */
  extensionsDir: string;
  log?: VoiceLog;
}

export interface VoiceWorldTrust {
  world: 'tts' | 'audio-play';
  package: string;
  packageVersion: string;
  declaredTools: string[];
  exposedTools: string[];
  schemaDigest: string | null;
  packageMatch: boolean;
  sourceMatch: boolean;
  exactDigest: boolean;
  executedWorldMatch: boolean;
  verified: boolean;
  findings: string[];
}

export interface VoiceTrustReport {
  schema: 'coopanion-voice-tool-trust/v1';
  /** Digests the Host adds to the request's trust set. Empty when nothing verified. */
  digests: string[];
  worlds: VoiceWorldTrust[];
  findings: string[];
}

const packageDirOf = (extensionsDir: string, root: VoiceToolSchemaRoot): string =>
  join(extensionsDir, 'node_modules', ...root.package.split('/'));

function realDir(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function insideRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

interface PackageIdentity {
  ok: boolean;
  version: string;
  sourceSha256: string;
  findings: string[];
}

/** Reads the installed package's identity from disk: name, version and the reviewed source bytes. */
function readPackageIdentity(extensionsDir: string, root: VoiceToolSchemaRoot): PackageIdentity {
  const findings: string[] = [];
  const dir = realDir(packageDirOf(extensionsDir, root));
  if (!dir) return { ok: false, version: '', sourceSha256: '', findings: [`package-missing:${root.package}`] };
  const rootDir = realDir(extensionsDir);
  if (!rootDir || !insideRoot(rootDir, dir)) {
    findings.push(`package-outside-extensions:${root.package}`);
  }
  let version = '';
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
    version = typeof pkg.version === 'string' ? pkg.version : '';
    if (pkg.name !== root.package) findings.push(`package-name-mismatch:${String(pkg.name)}`);
  } catch {
    findings.push(`package-json-unreadable:${root.package}`);
  }
  if (version !== root.packageVersion) findings.push(`package-version-mismatch:${version || 'unknown'}!=${root.packageVersion}`);
  let sourceSha256 = '';
  try {
    const sourcePath = realDir(join(extensionsDir, 'node_modules', ...root.source.split('/')));
    if (!sourcePath || !insideRoot(dir, sourcePath)) throw new Error('outside package');
    sourceSha256 = sha256(readFileSync(sourcePath));
  } catch {
    findings.push(`source-missing:${root.source}`);
  }
  if (sourceSha256 && sourceSha256 !== root.sourceSha256) findings.push('source-digest-mismatch');
  return { ok: findings.length === 0, version, sourceSha256, findings };
}

/** A context just complete enough to construct the reviewed World and read its declarations. */
function stubContext(definition: WorldDefinition<WorldSection>): unknown {
  const cwd = process.cwd();
  return {
    id: definition.id,
    cfg: definition.defaults(),
    timezone: 'UTC',
    botName: 'Coo',
    botDir: cwd,
    packageDir: cwd,
    dataDir: cwd,
    repoRoot: cwd,
    secret: () => '',
    storeSecret: () => {},
    persist: () => {},
    restart: async () => {},
  };
}

function declaredTools(definition: WorldDefinition<WorldSection>): ToolDef[] {
  try {
    return definition.create(stubContext(definition) as never).tools();
  } catch {
    return [];
  }
}

function digestOf(tools: readonly ToolDef[], name: string): string | null {
  const tool = tools.find((entry) => entry.name === name);
  return tool ? toolSchemaDigest(tool) : null;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

/**
 * The granted wrapper marks the outcome it returns. The Host admits exactly those receipts as
 * rendered text, the same way the desktop-pet World's own receipts are admitted: the mark proves
 * the text came from the reviewed World instance, not from a model message or another World.
 * It says nothing about the truth of what was synthesized; execution still produces a Receipt.
 */
function tagReceipt(tool: string, value: string | ToolOutcome): ToolOutcome {
  const outcome: ToolOutcome = typeof value === 'string' ? { text: value } : value;
  if (typeof outcome?.text === 'string') {
    Object.defineProperty(outcome, RECEIPT, { value: tool, enumerable: false, configurable: true });
  }
  return outcome;
}

export function isVoiceToolReceipt(tool: string, outcome: unknown): boolean {
  return !!outcome && typeof outcome === 'object'
    && (outcome as Record<symbol, unknown>)[RECEIPT] === tool;
}

/**
 * Wraps one reviewed World definition so the model only ever sees `root.exposes`, and so the
 * handlers refuse requests outside this round's authorization. Package bytes are untouched; only
 * the assembly's view of the World is narrowed.
 */
export function grantVoiceWorld(
  definition: WorldDefinition<WorldSection>,
  root: VoiceToolSchemaRoot,
  log?: VoiceLog,
): WorldDefinition<WorldSection> {
  return {
    ...definition,
    create: (ctx) => {
      const world = definition.create(ctx);
      const tools = world.tools();
      const exposed = tools.filter((tool) => root.exposes.includes(tool.name));
      const digest = digestOf(exposed, root.tool);
      if (exposed.length !== root.exposes.length || digest !== root.digest) {
        // The definition changed between the startup audit and this construction: expose nothing.
        log?.warn('[voice-trust] World 工具与批准摘要不一致，本轮不暴露任何工具', {
          world: root.world,
          got: exposed.map((tool) => tool.name),
          digest,
        });
        return new Proxy(world, {
          get(target, prop) {
            if (prop === 'tools') return () => [];
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      const guards = root.world === 'tts'
        ? [ttsSpeakGuard(world)]
        : [audioPlayGuard(world)];
      return new Proxy(world, {
        get(target, prop) {
          if (prop === GRANT) return root.world;
          if (prop === 'tools') {
            return () => exposed.map((tool) => ({
              ...tool,
              handler: async (args: Record<string, unknown>, callCtx: Parameters<ToolDef['handler']>[1]) => {
                const refusal = guards[0]?.(args);
                return tagReceipt(root.tool, refusal ?? await tool.handler(args, callCtx));
              },
            }));
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

/** `http://127.0.0.1:9881` style addresses only. A remote or non-http endpoint is refused. */
function isLoopbackEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

type Guard = (args: Record<string, unknown>) => ToolOutcome | null;

function ttsSpeakGuard(world: World): Guard {
  const live = world as unknown as { cfg?: Record<string, unknown> };
  return (args) => {
    const cfg = live.cfg ?? {};
    const baseUrl = typeof cfg.baseUrl === 'string' ? cfg.baseUrl.trim() : '';
    if (!isLoopbackEndpoint(baseUrl)) {
      return {
        text: `[tts_speak 没执行] 语音接口必须在本机回环地址上，本轮不授权 ${baseUrl || '（空地址）'}。`,
        failed: true,
      };
    }
    const configured = typeof cfg.voice === 'string' ? cfg.voice.trim() : '';
    const asked = typeof args.voice === 'string' ? args.voice.trim() : '';
    if (asked && configured && asked !== configured) {
      return {
        text: `[tts_speak 没执行] 本轮只授权已配置的音色 ${configured}。`,
        failed: true,
      };
    }
    const delivery = typeof args.delivery === 'string' ? args.delivery.trim() : '';
    if (delivery && delivery !== 'wait') {
      return { text: '[tts_speak 没执行] 本轮只授权同步交付（delivery=wait）。', failed: true };
    }
    return null;
  };
}

function audioPlayGuard(world: World): Guard {
  const live = world as unknown as { dataDir?: string };
  const clipRoot = (): string | null => {
    const dataDir = typeof live.dataDir === 'string' && live.dataDir ? live.dataDir : '';
    return dataDir ? realDir(join(dataDir, 'tts')) : null;
  };
  return (args) => {
    const raw = typeof args.audio === 'string' ? args.audio.trim().replace(/^["']|["']$/g, '') : '';
    if (!raw) return { text: '[audio_play 没执行] audio 是空的。', failed: true };
    // A conversation attachment handle is resolved by the Host; nothing else is left to the World.
    if (/^log:/i.test(raw)) return null;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      return {
        text: `[audio_play 没执行] 不接受 ${raw.slice(0, raw.indexOf(':')).toLowerCase()}: 引用；只播放本机语音链生成的音频或对话里的 log: 句柄。`,
        failed: true,
      };
    }
    if (!isAbsolute(raw)) {
      return { text: '[audio_play 没执行] 需要受控目录里的绝对路径或 log: 句柄，不接受相对路径。', failed: true };
    }
    const allowed = clipRoot();
    const real = realDir(raw);
    if (!allowed || !real || !insideRoot(allowed, real)) {
      return { text: '[audio_play 没执行] 只播放受控语音目录里的音频。', failed: true };
    }
    try {
      if (!statSync(real).isFile()) throw new Error('not a file');
    } catch {
      return { text: '[audio_play 没执行] 找不到音频文件。', failed: true };
    }
    return null;
  };
}

/**
 * Audits the definitions before the World assembly is built. On success the returned definitions
 * carry the narrowed, guarded Worlds; on any mismatch the original definition is returned unchanged
 * and no digest for it will be trusted.
 */
export function prepareVoiceWorlds(
  definitions: readonly WorldDefinition<WorldSection>[],
  opts: VoiceTrustOptions,
): { definitions: WorldDefinition<WorldSection>[]; report: VoiceTrustReport } {
  const findings: string[] = [];
  const worlds: VoiceWorldTrust[] = [];
  const wrapped = new Map<string, WorldDefinition<WorldSection>>();
  for (const root of VOICE_TOOL_SCHEMA_ROOTS) {
    const definition = definitions.find((entry) => entry.id === root.world);
    const identity = definition
      ? readPackageIdentity(opts.extensionsDir, root)
      : { ok: false, version: '', sourceSha256: '', findings: ['world-not-installed'] };
    const tools = definition ? declaredTools(definition) : [];
    const names = tools.map((tool) => tool.name);
    const digest = digestOf(tools, root.tool);
    const declaredMatch = definition ? sameSet(names, root.declares) : false;
    const exactDigest = digest === root.digest;
    const localFindings = [
      ...identity.findings,
      ...(declaredMatch ? [] : [`declared-tools-mismatch:${names.join(',') || 'none'}`]),
      ...(exactDigest ? [] : [`schema-digest-mismatch:${digest ?? 'none'}`]),
    ];
    const verified = identity.ok && declaredMatch && exactDigest;
    worlds.push({
      world: root.world,
      package: root.package,
      packageVersion: identity.version,
      declaredTools: names,
      exposedTools: [...root.exposes],
      schemaDigest: digest,
      packageMatch: identity.version === root.packageVersion,
      sourceMatch: identity.sourceSha256 === root.sourceSha256,
      exactDigest,
      executedWorldMatch: false,
      verified,
      findings: localFindings,
    });
    findings.push(...localFindings.map((finding) => `${root.world}:${finding}`));
    if (verified && definition) wrapped.set(root.world, grantVoiceWorld(definition, root, opts.log));
  }
  const next = definitions.map((definition) => wrapped.get(definition.id) ?? definition);
  return {
    definitions: next,
    report: { schema: 'coopanion-voice-tool-trust/v1', digests: [], worlds, findings },
  };
}

/**
 * Audits the mounted Worlds the Core is about to bind and returns the digests that may be trusted.
 * Runs after the assembly built the real instances, so it sees the same objects that will execute.
 */
export function auditVoiceWorlds(
  worlds: readonly World[],
  opts: VoiceTrustOptions,
): VoiceTrustReport {
  const report: VoiceTrustReport = {
    schema: 'coopanion-voice-tool-trust/v1',
    digests: [],
    worlds: [],
    findings: [],
  };
  const candidates: Array<{ root: VoiceToolSchemaRoot; digest: string; world: World }> = [];
  for (const root of VOICE_TOOL_SCHEMA_ROOTS) {
    const identity = readPackageIdentity(opts.extensionsDir, root);
    const world = worlds.find((entry) => entry.id === root.world);
    const tools = world?.tools() ?? [];
    const names = tools.map((tool) => tool.name);
    const digest = digestOf(tools, root.tool);
    const mark = world ? (world as unknown as Record<symbol, unknown>)[GRANT] : undefined;
    const localFindings: string[] = [...identity.findings];
    if (!world) localFindings.push('world-not-mounted');
    if (world && mark !== root.world) localFindings.push('execution-target-not-granted');
    if (!sameSet(names, root.exposes)) localFindings.push(`exposed-tools-mismatch:${names.join(',') || 'none'}`);
    if (digest !== root.digest) localFindings.push(`schema-digest-mismatch:${digest ?? 'none'}`);
    const verified = identity.ok && !!world && mark === root.world
      && sameSet(names, root.exposes) && digest === root.digest;
    report.worlds.push({
      world: root.world,
      package: root.package,
      packageVersion: identity.version,
      declaredTools: [...root.declares],
      exposedTools: names,
      schemaDigest: digest,
      packageMatch: identity.version === root.packageVersion,
      sourceMatch: identity.sourceSha256 === root.sourceSha256,
      exactDigest: digest === root.digest,
      executedWorldMatch: !!world && mark === root.world,
      verified,
      findings: localFindings,
    });
    report.findings.push(...localFindings.map((finding) => `${root.world}:${finding}`));
    if (verified && world && digest) candidates.push({ root, digest, world });
  }

  // Another mounted World that declares the same bytes would be indistinguishable to the request
  // layer, so a voice digest is dropped when anything besides the granted instance claims it.
  const approved = new Set(candidates.map((candidate) => candidate.world.id));
  const impersonated = new Set<string>();
  for (const world of worlds) {
    if (approved.has(world.id)) continue;
    for (const tool of world.tools()) {
      const digest = toolSchemaDigest(tool);
      if (digest && candidates.some((candidate) => candidate.digest === digest)) {
        impersonated.add(digest);
        report.findings.push(`impersonation:${world.id}:${tool.name}`);
      }
    }
  }
  for (const candidate of candidates) {
    if (impersonated.has(candidate.digest)) {
      const entry = report.worlds.find((item) => item.world === candidate.root.world);
      if (entry) {
        entry.verified = false;
        entry.findings.push('digest-claimed-by-another-world');
      }
      continue;
    }
    report.digests.push(candidate.digest);
  }
  if (report.findings.length) {
    opts.log?.warn('[voice-trust] 语音工具可信审计', { report });
  }
  return report;
}
