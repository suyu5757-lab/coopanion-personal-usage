import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { assertDevDataRoot } = require('../app/dev-data-guard.cjs') as {
  assertDevDataRoot: (options: Record<string, unknown>) => { dataRoot: string; scratchRoot: string; productionRoot: string };
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout() {
  const base = mkdtempSync(join(tmpdir(), 'coopanion-dev-guard-'));
  roots.push(base);
  const appScratch = join(base, 'checkout', 'scratch');
  const runRoot = join(appScratch, 'run-1');
  const production = join(base, 'Library', 'Application Support', 'Coopanion');
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(production, { recursive: true });
  return { base, appScratch, runRoot, production, dataRoot: join(runRoot, 'p1-profile') };
}

function guard(parts: ReturnType<typeof layout>, overrides: Record<string, unknown> = {}) {
  return assertDevDataRoot({
    dataRoot: parts.dataRoot,
    scratchRoot: parts.runRoot,
    appScratch: parts.appScratch,
    productionRoot: parts.production,
    ...overrides,
  });
}

describe('dev settings data-root guard', () => {
  it('accepts and creates a profile strictly inside this run scratch root', () => {
    const parts = layout();
    const result = guard(parts);
    expect(result.dataRoot).toBe(realpathSync(parts.dataRoot));
    expect(result.scratchRoot).toBe(realpathSync(parts.runRoot));
  });

  it('rejects a missing data root when creation is disabled', () => {
    const parts = layout();
    expect(() => guard(parts, { create: false })).toThrow(/does not exist/);
  });

  it('rejects missing, empty and relative data roots', () => {
    const parts = layout();
    expect(() => guard(parts, { dataRoot: undefined })).toThrow(/not set/);
    expect(() => guard(parts, { dataRoot: '' })).toThrow(/not set/);
    expect(() => guard(parts, { dataRoot: 'relative/profile' })).toThrow(/not absolute/);
  });

  it('rejects the production root and its children', () => {
    const parts = layout();
    expect(() => guard(parts, { dataRoot: parts.production })).toThrow(/production/);
    expect(() => guard(parts, { dataRoot: join(parts.production, 'home', 'companion') })).toThrow(/production/);
  });

  it('rejects a data root outside the run scratch root', () => {
    const parts = layout();
    expect(() => guard(parts, { dataRoot: join(parts.base, 'elsewhere') })).toThrow(/run scratch/);
    expect(() => guard(parts, { dataRoot: parts.runRoot })).toThrow(/run scratch/);
  });

  it('rejects a run scratch root outside this checkout scratch or equal to it', () => {
    const parts = layout();
    const other = join(parts.base, 'other-run');
    mkdirSync(other, { recursive: true });
    expect(() => guard(parts, { scratchRoot: other })).toThrow(/checkout scratch/);
    expect(() => guard(parts, { scratchRoot: parts.appScratch })).toThrow(/checkout scratch/);
  });

  it('rejects a run scratch root that is an ancestor of production', () => {
    const parts = layout();
    const production = join(parts.runRoot, 'production');
    mkdirSync(production, { recursive: true });
    expect(() => guard(parts, { productionRoot: production })).toThrow(/production/);
  });

  it('rejects a symlink to the production root', () => {
    const parts = layout();
    const link = join(parts.runRoot, 'linked-profile');
    symlinkSync(parts.production, link);
    expect(() => guard(parts, { dataRoot: link })).toThrow(/production/);
  });

  it('rejects a .. path that resolves outside the run scratch root', () => {
    const parts = layout();
    const escaped = join(parts.runRoot, 'p1-profile', '..', '..', '..', 'outside');
    expect(() => guard(parts, { dataRoot: escaped })).toThrow(/run scratch/);
  });

  it('rejects a data root that is a file', () => {
    const parts = layout();
    writeFileSync(parts.dataRoot, 'not a directory');
    expect(() => guard(parts)).toThrow(/not a directory/);
  });
});
