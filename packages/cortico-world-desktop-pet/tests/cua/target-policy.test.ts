import { describe, expect, it } from 'vitest';
import { isSupportedCuaTarget } from '../../src/cua/target-policy.ts';

describe('CUA native window target policy', () => {
  it('allows the exact TextEdit app bundle and executable through the private driver', () => {
    expect(isSupportedCuaTarget({
      source: 'cua-driver',
      route: 'background-ax',
      bundleId: 'com.apple.TextEdit',
      executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
    })).toBe(true);
  });

  it('keeps browser windows, other apps, and non-window routes closed', () => {
    const target = {
      source: 'cua-driver',
      route: 'background-window-pixel',
      bundleId: 'com.apple.TextEdit',
      executablePath: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit',
    };
    expect(isSupportedCuaTarget({ ...target, bundleId: 'com.apple.Safari' })).toBe(false);
    expect(isSupportedCuaTarget({ ...target, bundleId: 'com.example.Editor' })).toBe(false);
    expect(isSupportedCuaTarget({ ...target, executablePath: '/Applications/TextEdit.app/Contents/MacOS/TextEdit' })).toBe(false);
    expect(isSupportedCuaTarget({ ...target, source: 'display-capture' })).toBe(false);
    expect(isSupportedCuaTarget({ ...target, route: 'foreground' })).toBe(false);
  });
});
