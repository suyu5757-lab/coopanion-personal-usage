import { describe, expect, it } from 'vitest';
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


describe.runIf(process.platform === 'darwin')('private Cua Driver protocol', () => {
  const fixture = () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-driver-test-'));
    const bin = join(dir, 'cua-driver.cjs');
    const socket = join(dir, 'driver.sock');
    const state = join(dir, 'state.json');
    writeFileSync(socket, 'fixture endpoint');
    writeFileSync(state, JSON.stringify({ active: true, sessions: [], captures: 0, actions: 0, starts: 0, serves: 0 }));
    writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs');
const file=${JSON.stringify(state)};
const expectedSocket=${JSON.stringify(socket)};
const args=process.argv.slice(2);
const state=JSON.parse(fs.readFileSync(file,'utf8'));
const socketIndex=args.indexOf('--socket');
if(socketIndex<0||args[socketIndex+1]!==expectedSocket){console.error('private socket required');process.exit(41)}
if(args[0]==='status'){
 if(!state.active){console.error('not running');process.exit(1)}
 console.log('daemon is running');process.exit(0)
}
if(args[0]==='serve'){state.serves++;fs.writeFileSync(file,JSON.stringify(state));process.exit(42)}
if(args[0]!=='call'||args[2]===undefined)process.exit(2)
const payload=JSON.parse(args[2]);
if(payload.session!=='run-test-1')process.exit(43)
if(args[1]==='start_session'){
 state.starts++;
 state.sessions.push(payload.session);
 fs.writeFileSync(file,JSON.stringify(state));
 console.log('{}');process.exit(0)
}
if(!state.sessions.includes(payload.session))process.exit(44)
if(args[1]==='get_window_state'){
 if(payload.tree_format!=='elements'||payload.max_elements!==512||payload.query!=='Save')process.exit(45)
 state.captures++;fs.writeFileSync(file,JSON.stringify(state));
 console.log(JSON.stringify({app_name:'Test window',owner_pid:12,window_bounds:{x:5,y:6,width:100,height:80},screenshot_width:100,screenshot_height:80,capture_id:'cap-1',snapshot_id:'snap-1',truncated:true,truncation_reason:'max_elements',elements_complete:false,elements:[{element_index:7,element_token:'snap-1:7',role:'button',label:'Save file',value:'draft.txt',actions:['press'],frame:{x:1,y:2,width:30,height:10},parent_index:2,depth:3}]}));process.exit(0)
}
if(args[1]==='click'){
 if(payload.element_token!=='snap-1:7'||payload.action!=='press')process.exit(46)
 state.actions++;fs.writeFileSync(file,JSON.stringify(state));
 console.log(JSON.stringify({effect:'confirmed',summary:'pressed',route:'accessibility'}));process.exit(0)
}
process.exit(2);
`);
    chmodSync(bin, 0o755);
    const options = { binaryPath: bin, endpoint: 'unix-socket' as const, socketPath: socket, session: 'run-test-1', lifecycle: 'external-managed' as const };
    return { dir, state, options };
  };

  it('uses the configured private socket, structured snapshot, owner and current element token', async () => {
    const f = fixture();
    try {
      const driver = new CuaDriver(f.options);
      expect(driver.available()).toBe(true);
      const capture = await driver.capture(12, 34, { screenshot: false, maxDimension: 1280, quality: 75, maxElements: 512, query: 'Save' });
      expect(capture).toMatchObject({
        title: 'Test window', pid: 12, ownerPid: 12, windowId: 34,
        captureId: 'cap-1', snapshotId: 'snap-1', truncated: true,
        truncationReason: 'max_elements', elementsComplete: false,
        elements: [{ token: 'snap-1:7', index: 7, role: 'button', label: 'Save file', value: 'draft.txt', actions: ['press'], parentIndex: 2, depth: 3 }],
      });
      expect(await driver.clickElement(12, 34, 'snap-1:7')).toMatchObject({ effect: 'confirmed', route: 'accessibility' });
      expect(JSON.parse(readFileSync(f.state, 'utf8'))).toMatchObject({ starts: 1, captures: 1, actions: 1, serves: 0 });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('does not reopen a retired session or start a global daemon', async () => {
    const f = fixture();
    try {
      const driver = new CuaDriver(f.options);
      await driver.capture(12, 34, { screenshot: false, maxDimension: 1280, quality: 75, maxElements: 512, query: 'Save' });
      const state = JSON.parse(readFileSync(f.state, 'utf8'));
      writeFileSync(f.state, JSON.stringify({ ...state, active: false }));
      await expect(driver.capture(12, 34, { screenshot: false, maxDimension: 1280, quality: 75, maxElements: 512, query: 'Save' }))
        .rejects.toMatchObject({ code: 'private_endpoint_unavailable' });
      expect(JSON.parse(readFileSync(f.state, 'utf8'))).toMatchObject({ starts: 1, captures: 1, serves: 0 });
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
