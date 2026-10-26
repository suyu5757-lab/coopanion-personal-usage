/** `worlds.opencode`: the executable, the directories a task may run in, and its budgets. */
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ConfigGroup } from 'cortico/core/config-schema.ts';
import type { WorldSection } from 'cortico/world.ts';

export interface OpencodeConfigSection extends WorldSection {
  enabled: boolean;
  /** The `opencode` executable; `opencode` from `PATH` by default. */
  bin: string;
  /** Absolute directories a task may run in, separated by a newline, comma or semicolon. */
  workRoots: string;
  /** The longest one task may run, in minutes. */
  taskMinutes: number;
  /** How long a permission request waits for the person, in minutes. */
  permissionMinutes: number;
  /** Force opencode to ask before writing, running commands, fetching pages or starting subagents. */
  askSensitive: boolean;
}

export const OPENCODE_DEFAULTS: OpencodeConfigSection = {
  enabled: false,
  bin: 'opencode',
  workRoots: '',
  taskMinutes: 30,
  permissionMinutes: 3,
  askSensitive: true,
};

export const TASK_MINUTES_MAX = 240;
export const PERMISSION_MINUTES_MAX = 30;

/** The live config with numbers clamped and the executable trimmed. */
export function readConfig(cfg: OpencodeConfigSection): OpencodeConfigSection {
  const minutes = (value: number, fallback: number, max: number) =>
    (Number.isFinite(value) ? Math.min(max, Math.max(1, Math.round(value))) : fallback);
  return {
    enabled: cfg.enabled === true,
    bin: typeof cfg.bin === 'string' && cfg.bin.trim() ? cfg.bin.trim() : OPENCODE_DEFAULTS.bin,
    workRoots: typeof cfg.workRoots === 'string' ? cfg.workRoots : '',
    taskMinutes: minutes(cfg.taskMinutes, OPENCODE_DEFAULTS.taskMinutes, TASK_MINUTES_MAX),
    permissionMinutes: minutes(cfg.permissionMinutes, OPENCODE_DEFAULTS.permissionMinutes, PERMISSION_MINUTES_MAX),
    askSensitive: cfg.askSensitive !== false,
  };
}

/** The directories `workRoots` names, absolute and without duplicates. */
export function workRoots(cfg: OpencodeConfigSection): string[] {
  const out: string[] = [];
  for (const raw of cfg.workRoots.split(/[\r\n,;]+/)) {
    let path = raw.trim();
    if (!path) continue;
    if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = homedir() + path.slice(1);
    const dir = resolve(path);
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}

/** Whether `dir` is one of `roots` or inside one. */
export function insideRoot(roots: readonly string[], dir: string): boolean {
  const target = resolve(dir);
  return roots.some((root) => {
    const rel = relative(resolve(root), target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  });
}

const K = 'worlds.opencode';

/** The config group shown on the World's page in the advanced settings. */
export const OPENCODE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:opencode',
  owner: 'world:opencode',
  schema: {
    type: 'object',
    title: 'opencode',
    properties: {
      [`${K}.bin`]: { type: 'string', title: 'bin', 'x-path': { kind: 'file' } },
      [`${K}.workRoots`]: { type: 'string', title: 'workRoots' },
      [`${K}.taskMinutes`]: { type: 'integer', title: 'taskMinutes', minimum: 1, maximum: TASK_MINUTES_MAX, 'x-suffix': 'min' },
      [`${K}.permissionMinutes`]: { type: 'integer', title: 'permissionMinutes', minimum: 1, maximum: PERMISSION_MINUTES_MAX, 'x-suffix': 'min' },
      [`${K}.askSensitive`]: { type: 'boolean', title: 'askSensitive' },
    },
  },
};
