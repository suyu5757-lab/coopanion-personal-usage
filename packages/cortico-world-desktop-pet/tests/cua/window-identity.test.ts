import { describe, expect, it } from 'vitest';
import { executableFromLsof, resolveDarwinProcessIdentity, type MetadataCommand } from '../../src/cua/window-identity.ts';

describe('Cua Driver window process identity', () => {
  it('selects the executable from a text-file descriptor', () => {
    expect(executableFromLsof([
      'p501',
      'ftxt',
      'n/Applications/TextEdit.app/Contents/MacOS/TextEdit',
      'fcwd',
      'n/Users/example',
    ].join('\n'))).toBe('/Applications/TextEdit.app/Contents/MacOS/TextEdit');
  });

  it('resolves an app bundle, executable path and process start time', async () => {
    const outputs: Record<string, string> = {
      '/bin/ps': 'Tue Oct 28 09:30:00 2026\n',
      '/usr/sbin/lsof': 'p501\nftxt\nn/Applications/TextEdit.app/Contents/MacOS/TextEdit\n',
      '/usr/libexec/PlistBuddy': 'com.apple.TextEdit\n',
    };
    const run: MetadataCommand = async (file, args) => {
      if (file === '/usr/libexec/PlistBuddy') expect(args.at(-1)).toBe('/Applications/TextEdit.app/Contents/Info.plist');
      return outputs[file] ?? '';
    };

    await expect(resolveDarwinProcessIdentity(501, { platform: 'darwin', run })).resolves.toEqual({
      bundleId: 'com.apple.TextEdit',
      executablePath: '/Applications/TextEdit.app/Contents/MacOS/TextEdit',
      processStart: 'Tue Oct 28 09:30:00 2026',
    });
  });

  it('returns unknown for invalid pids, non-app executables and unavailable metadata', async () => {
    const run: MetadataCommand = async (file) => {
      if (file === '/bin/ps') return 'Tue Oct 28 09:30:00 2026';
      if (file === '/usr/sbin/lsof') return 'p501\nftxt\nn/usr/bin/vi';
      return 'not a bundle id';
    };

    await expect(resolveDarwinProcessIdentity(0, { platform: 'darwin', run })).resolves.toBeNull();
    await expect(resolveDarwinProcessIdentity(501, { platform: 'darwin', run })).resolves.toBeNull();
    await expect(resolveDarwinProcessIdentity(501, { platform: 'linux', run })).resolves.toBeNull();
  });
});
