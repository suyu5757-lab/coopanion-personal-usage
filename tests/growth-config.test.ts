import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyGrowthConfig } from '../core/growth/config.ts';

const roots: string[] = [];
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), 'coo-growth-config-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Growth config migration', () => {
  it('disables a saved legacy schedule once and preserves the original config', () => {
    const root = temp();
    const configFile = join(root, 'config.json');
    const original = `${JSON.stringify({
      companion: { growth: { enabled: true, everyDays: 7 } },
      worlds: { browser: { enabled: true } },
    }, null, 2)}\n`;
    writeFileSync(configFile, original);
    const config = { companion: { growth: { enabled: true, everyDays: 7 } } };

    expect(migrateLegacyGrowthConfig(root, config)).toBe(true);
    expect(config.companion.growth.enabled).toBe(false);
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({
      companion: { growth: { enabled: false, everyDays: 7 } },
      worlds: { browser: { enabled: true } },
    });
    expect(readFileSync(join(root, 'config.json.pre-v23-growth'), 'utf8')).toBe(original);

    config.companion.growth.enabled = true;
    writeFileSync(configFile, JSON.stringify({ companion: { growth: { enabled: true, everyDays: 14 } } }));
    expect(migrateLegacyGrowthConfig(root, config)).toBe(false);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).companion.growth.enabled).toBe(true);
  });

  it('leaves explicit off and default-off settings off', () => {
    const root = temp();
    const configFile = join(root, 'config.json');
    writeFileSync(configFile, JSON.stringify({ companion: { growth: { enabled: false, everyDays: 7 } } }));
    expect(migrateLegacyGrowthConfig(root, { companion: { growth: { enabled: false, everyDays: 7 } } })).toBe(false);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).companion.growth.enabled).toBe(false);

    const newRoot = temp();
    expect(migrateLegacyGrowthConfig(newRoot, { companion: { growth: { enabled: false, everyDays: 7 } } })).toBe(false);
  });
});
