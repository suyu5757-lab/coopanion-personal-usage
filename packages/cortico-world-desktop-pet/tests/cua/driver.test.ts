import { describe, expect, it } from 'vitest';
import { driverKeyChords } from '../../src/cua/driver.ts';

describe('driverKeyChords', () => {
  it('reads modifier chords and sequences in the driver vocabulary', () => {
    expect(driverKeyChords('ctrl+s')).toEqual([{ modifiers: ['ctrl'], key: 's' }]);
    expect(driverKeyChords('cmd+shift+t')).toEqual([{ modifiers: ['cmd', 'shift'], key: 't' }]);
    expect(driverKeyChords('ctrl+a delete')).toEqual([
      { modifiers: ['ctrl'], key: 'a' },
      { modifiers: [], key: 'delete' },
    ]);
    expect(driverKeyChords('enter')).toEqual([{ modifiers: [], key: 'return' }]);
  });

  it('maps aliases and the plus key', () => {
    expect(driverKeyChords('option+pgdn')).toEqual([{ modifiers: ['option'], key: 'pagedown' }]);
    expect(driverKeyChords('ctrl++')).toEqual([{ modifiers: ['ctrl'], key: '+' }]);
    expect(driverKeyChords('control+esc')).toEqual([{ modifiers: ['ctrl'], key: 'escape' }]);
  });

  it('names the shapes the driver cannot take', () => {
    expect(driverKeyChords('ctrl+a+b')).toEqual({ error: 'oneKey' });
    expect(driverKeyChords('cmd')).toEqual({ error: 'oneKey' });
    expect(driverKeyChords('volumeup')).toEqual({ error: 'unsupported', key: 'volumeup' });
    expect(driverKeyChords('f13')).toEqual({ error: 'unsupported', key: 'f13' });
    expect(driverKeyChords('f12')).toEqual([{ modifiers: [], key: 'f12' }]);
    expect(driverKeyChords('  ')).toEqual({ error: 'empty' });
  });
});
