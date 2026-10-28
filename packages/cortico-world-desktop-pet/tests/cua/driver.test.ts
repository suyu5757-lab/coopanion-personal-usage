import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuaDriver, driverKeyChords } from '../../src/cua/driver.ts';

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


describe.runIf(process.platform !== 'win32')('driver lifecycle', () => {
  it('reopens an idle-expired CLI session before capturing without retrying the action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-driver-test-'));
    const bin = join(dir, 'cua-driver.cjs');
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ active: false, captures: 0 }));
    writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs');
const file=${JSON.stringify(state)};
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const args=process.argv.slice(2);
if(args[0]==='status'){console.log('daemon is running');process.exit(0)}
if(args[1]==='start_session'){state.active=true;fs.writeFileSync(file,JSON.stringify(state));console.log('{}');process.exit(0)}
if(args[1]==='get_window_state'){
 if(!state.active){console.error('session has ended');process.exit(1)}
 state.captures++;fs.writeFileSync(file,JSON.stringify(state));console.log(JSON.stringify({capture_id:'capture-'+state.captures,window_title:'Test window',screenshot_width:100,screenshot_height:80}));process.exit(0)
}
process.exit(2);
`);
    chmodSync(bin, 0o755);
    vi.stubEnv('CUA_DRIVER_BIN', bin);
    try {
      const driver = new CuaDriver('test-window');
      const options = { screenshot: false, maxDimension: 1280, quality: 75 };
      expect((await driver.capture(12, 34, options)).captureId).toBe('capture-1');
      const previous = JSON.parse(readFileSync(state, 'utf8'));
      writeFileSync(state, JSON.stringify({ ...previous, active: false }));
      expect((await driver.capture(12, 34, options)).captureId).toBe('capture-2');
      expect(JSON.parse(readFileSync(state, 'utf8')).captures).toBe(2);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requests the accessibility tree and presses a token from the returned snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-driver-ax-test-'));
    const bin = join(dir, 'cua-driver.cjs');
    const state = join(dir, 'state.json');
    writeFileSync(state, JSON.stringify({ calls: [] }));
    writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs');
const file=${JSON.stringify(state)};
const args=process.argv.slice(2);
if(args[0]==='status'){console.log('daemon is running');process.exit(0)}
if(args[0]!=='call'){process.exit(2)}
const payload=JSON.parse(args[2]);
const state=JSON.parse(fs.readFileSync(file,'utf8'));
state.calls.push({tool:args[1],payload});
fs.writeFileSync(file,JSON.stringify(state));
if(args[1]==='start_session'){console.log('{}');process.exit(0)}
if(args[1]==='get_window_state'){
 console.log(JSON.stringify({app_name:'Test window',screenshot_width:100,screenshot_height:80,capture_id:'cap-1',snapshot_id:'snap-1',elements:[{element_token:'snap-1:7',role:'button',name:'Submit',value:'private text',actions:['press']}]}));process.exit(0)
}
if(args[1]==='click'){
 console.log(JSON.stringify({effect:'confirmed',summary:'pressed',route:'accessibility'}));process.exit(0)
}
process.exit(2);
`);
    chmodSync(bin, 0o755);
    vi.stubEnv('CUA_DRIVER_BIN', bin);
    try {
      const driver = new CuaDriver('test-window');
      const capture = await driver.capture(12, 34, { screenshot: false, maxDimension: 1280, quality: 75 });
      expect(capture).toMatchObject({
        title: 'Test window', captureId: 'cap-1', snapshotId: 'snap-1',
        elements: [{ token: 'snap-1:7', role: 'button', label: 'Submit', value: 'private text', actions: ['press'] }],
      });
      expect(await driver.clickElement(12, 34, 'snap-1:7')).toMatchObject({ effect: 'confirmed', route: 'accessibility' });
      const calls = JSON.parse(readFileSync(state, 'utf8')).calls;
      expect(calls.find((call: { tool: string }) => call.tool === 'get_window_state').payload).toMatchObject({
        pid: 12, window_id: 34, include_accessibility_tree: true,
      });
      expect(calls.find((call: { tool: string }) => call.tool === 'click').payload).toMatchObject({
        pid: 12, window_id: 34, element_token: 'snap-1:7', action: 'press', delivery_mode: 'background',
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
