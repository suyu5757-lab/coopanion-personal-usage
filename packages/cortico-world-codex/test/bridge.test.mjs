import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CodexWorld } from '../index.mjs';

async function fixture(t, script) {
  const base = await mkdtemp(resolve(process.env.CODEX_BRIDGE_TEST_TMP || '.', 'codex-bridge-test-'));
  const root = join(base, 'allowed');
  await mkdir(root);
  const bin = join(base, 'fake-codex');
  await writeFile(bin, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  const events = [];
  const world = new CodexWorld({ cfg: { enabled: true, bin, workRoots: root, taskMinutes: 1 }, dataDir: join(base, 'data') });
  await world.start({ pushEvent: async (e, opts) => { events.push({ ...e, opts }); return e; }, log: { warn() {} } });
  t.after(async () => { await world.stop(); await rm(base, { recursive: true }); });
  const call = (name, args = {}) => world.tools().find(x => x.name === name).handler(args, {});
  return { world, root, base, events, call };
}

const success = `
let input = ''; process.stdin.on('data', b => input += b); process.stdin.on('end', () => {
const events = [
 {type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000001'},
 {type:'turn.started'},
 {type:'item.completed',item:{id:'c1',type:'command_execution',command:'node --version',status:'completed',exit_code:0,aggregated_output:'v24'}},
 {type:'item.completed',item:{id:'f1',type:'file_change',changes:[{path:'example.txt',kind:'add'}]}},
 {type:'item.completed',item:{id:'m1',type:'agent_message',text:process.argv.includes('resume')?'RESUMED 中文':'SUCCESS 中文'}},
 {type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}
];
const bytes = Buffer.from(events.map(e => JSON.stringify(e)).join('\\n'));
let offset=0; const timer=setInterval(() => { process.stdout.write(bytes.subarray(offset,offset+7)); offset+=7; if(offset>=bytes.length)clearInterval(timer); },1);
});`;

test('parses fragmented UTF-8 and final line; persists review; delivers exactly one result', async t => {
  const { world, events, call } = await fixture(t, success);
  assert.equal((await call('codex_task', { task: '核验', readOnly: true })).failed, undefined);
  await world.active.done;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'codex.result');
  assert.equal(events[0].opts.trigger, 'preempt');
  assert.equal(world.last.summary, 'SUCCESS 中文');
  assert.deepEqual(world.last.files, ['example.txt']);
  assert.equal(world.last.commands[0].exitCode, 0);
  assert.equal(JSON.parse(await readFile(world.reviewFile, 'utf8')).ok, true);
});

test('rejects outside directories and symlink escapes before spawning', async t => {
  const { root, base, events, call } = await fixture(t, success);
  const outside = join(base, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, 'escape'));
  for (const dir of [outside, join(root, 'escape'), 'relative-path']) {
    assert.equal((await call('codex_task', { task: 'do not execute', dir })).failed, true);
  }
  assert.equal(events.length, 0);
});

test('does not mark a turn.failed with process exit zero as success', async t => {
  const { world, events, call } = await fixture(t, `process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({type:'turn.failed',error:{message:'quota unavailable'}})));`);
  await call('codex_task', { task: 'probe' }); await world.active.done;
  assert.equal(events[0].type, 'codex.failed');
  assert.equal(world.last.ok, false);
  assert.match(world.last.error, /quota unavailable/);
});

test('busy and wrong-id cancellation cannot replace or stop the active task', async t => {
  const { world, events, call } = await fixture(t, `process.stdin.resume(); setInterval(()=>{},1000);`);
  await call('codex_task', { task: 'wait' });
  const current = world.active;
  assert.equal((await call('codex_task', { task: 'another' })).failed, true);
  assert.equal((await call('codex_stop', { taskId: 'wrong' })).failed, true);
  assert.equal(world.active, current);
  await call('codex_stop', { taskId: current.id }); await current.done;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'codex.failed');
  assert.equal(world.last.stop, 'cancelled');
  assert.equal(world.status().running, false);
});

test('resume uses the recorded exact session and matching sandbox; never --last', async t => {
  const { world, call } = await fixture(t, success);
  assert.equal((await call('codex_task', { task: 'probe', resume: true })).failed, true);
  await call('codex_task', { task: 'first', readOnly: true }); await world.active.done;
  assert.equal((await call('codex_task', { task: 'wrong mode', resume: true })).failed, true);
  await call('codex_task', { task: 'second', resume: true, readOnly: true }); await world.active.done;
  assert.equal(world.last.summary, 'RESUMED 中文');
});

test('missing binary produces one failure and releases the active slot', async t => {
  const { world, events, call } = await fixture(t, success);
  world.ctx.cfg.bin = join(world.ctx.dataDir, 'not-installed');
  await call('codex_task', { task: 'probe' }); const pending = world.active;
  if (pending) await pending.done;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'codex.failed');
  assert.equal(world.status().running, false);
});

test('shutdown reaps the child and suppresses new wakeup events', async t => {
  const { world, events, call } = await fixture(t, `process.stdin.resume(); setInterval(()=>{},1000);`);
  await call('codex_task', { task: 'wait' });
  const pid = world.active.child.pid;
  await world.stop();
  assert.equal(world.status().running, false);
  assert.equal(world.last.stop, 'shutdown');
  assert.equal(events.length, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
