import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome, WorldHost } from 'cortico/core/types.ts';
import { actionDigest, hashContent } from '../core/browser/actions.ts';
import type { BrowserTransport } from '../core/browser/bridge.ts';
import { SELF_TIME_DEFAULTS } from '../core/browser/config.ts';
import type { ApprovalAnswer } from '../core/browser/world.ts';
import { BrowserWorld } from '../core/browser/world.ts';

type Page = {
  url: string; title: string; header: string; content: string; footer: string;
  video: null; elements: Array<{ id: number; label: string }>;
  current: { url: string; title: string } | null;
  account: { ref: string; label: string } | null;
  snapshotId: string;
  replyTargets?: Array<{ boxId: number; fingerprint: string; evidenceHash: string; author: string; context: string; timestamp: string; needsExpand: boolean }>;
  statusMessages?: string[];
};

const page = (overrides: Partial<Page> = {}): Page => ({
  url: 'https://www.douyin.com/video/123',
  title: '抖音',
  header: '',
  content: '*[2]<textarea placeholder=留下你的精彩评论 />\n*[3]<button >发送 />',
  footer: '',
  video: null,
  elements: [{ id: 2, label: '' }, { id: 3, label: '发送' }],
  current: { url: 'https://www.douyin.com/video/123', title: '海边的下午' },
  account: { ref: 'https://www.douyin.com/user/account-1', label: '我的主页' },
  snapshotId: 'snapshot-1',
  ...overrides,
});

const element = (overrides: Record<string, unknown> = {}) => ({
  id: 2, tag: 'textarea', text: '', label: '', type: '', placeholder: '留下你的精彩评论', aria: '', title: '', role: 'textbox', snapshotId: 'snapshot-1',
  href: '', disabled: false, visible: true, ...overrides,
});

class FakeBridge implements BrowserTransport {
  readonly calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  state = page();
  box = element();
  button = element({ id: 3, tag: 'button', role: '', placeholder: '', label: '发送', text: '发送', snapshotId: 'snapshot-1' });
  /** What the box holds now; the host's own typing sets it. */
  draft = '';
  /** Set to make the next action op throw after the input could have left. */
  failOn: string | null = null;
  /** A reply-specific notice emitted by the page as a result of this Enter. */
  replyStatusAfterPress: string[] | null = null;

  async call(op: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ op, args });
    if (op === 'element') return args.index === 3 ? this.button : this.box;
    if (op === 'active') return this.box;
    if (op === 'draft') return this.draft;
    if (op === 'open' || op === 'read') return this.state;
    if (op === 'input') { this.draft = String(args.text ?? ''); return { answer: { success: true }, state: this.state }; }
    if (op === 'press' || op === 'click') {
      if (this.failOn === op) { this.failOn = null; throw new Error('the page did not answer'); }
      if (op === 'click' || args.key === 'Enter') this.draft = '';
      if (op === 'press' && args.key === 'Enter' && this.replyStatusAfterPress) {
        this.state.statusMessages = this.replyStatusAfterPress;
        this.replyStatusAfterPress = null;
      }
      return { answer: { success: true }, state: this.state };
    }
    return this.state;
  }

  onEvent(): () => void { return () => {}; }
}

const host = (pushed: Array<Record<string, unknown>>) => ({
  modelFacts: { accepts: () => true },
  pushEvent: async (event: Record<string, unknown>) => {
    pushed.push(event);
    return { ...event, cursor: pushed.length, origin: 'external', contextDelivery: 'deliver' };
  },
} as unknown as WorldHost);

const run = async (world: BrowserWorld, name: string, args: Record<string, unknown>): Promise<ToolOutcome> => {
  const tool = world.tools().find((t) => t.name === name)!;
  const out = await tool.handler(args, {} as ToolCallContext);
  return typeof out === 'string' ? { text: out } : out;
};

const make = async (opts: {
  ask?: (question: string, choices: [string, string]) => Promise<ApprovalAnswer>;
  journalFile?: string;
  taskJournalFile?: string;
  replyJournalFile?: string | null;
  bridge?: FakeBridge;
  pushed?: Array<Record<string, unknown>>;
} = {}) => {
  const bridge = opts.bridge ?? new FakeBridge();
  const pushed = opts.pushed ?? [];
  const dir = mkdtempSync(join(tmpdir(), 'coo-approval-'));
  tempDirs.push(dir);
  const taskJournalFile = opts.taskJournalFile ?? join(dir, 'task-actions.json');
  const world = new BrowserWorld({
    bridge,
    selfTime: () => ({ ...SELF_TIME_DEFAULTS, enabled: true, actions: true }),
    modelLanguage: () => 'zh',
    language: () => 'zh',
    timezone: 'Asia/Shanghai',
    ...(opts.ask ? { ask: opts.ask } : {}),
    journalFile: opts.journalFile ?? join(dir, 'actions.json'),
    taskJournalFile,
    ...(opts.replyJournalFile === null ? {} : { replyJournalFile: opts.replyJournalFile ?? join(dir, 'replies.json') }),
  });
  await world.start(host(pushed));
  await run(world, 'browser_open', { url: 'https://www.douyin.com/video/123' });
  return { world, bridge, pushed, dir, taskJournalFile };
};

const yes = async () => 'yes' as const;
const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('public write approval', () => {
  it('asks with the video and the exact text, sends once, and reports what the page shows', async () => {
    let question = '';
    const bridge = new FakeBridge();
    const { world, taskJournalFile } = await make({
      bridge,
      ask: async (q) => { question = q; return 'yes'; },
    });
    bridge.draft = '海边的风很大';
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(question).toContain('海边的下午');
    expect(question).toContain('我的主页');
    expect(question).toContain('https://www.douyin.com/user/account-1');
    expect(question).toContain('海边的风很大');
    expect(out.failed).toBeUndefined();
    expect(out.text).toContain('输入框已清空,提交动作已观察到');
    expect(out.text).toContain('没有给出审核或公开状态');
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))).toMatchObject([{ phase: 'verified', outcome: 'ui-observed' }]);
  });

  it('sends nothing when the person says no', async () => {
    const bridge = new FakeBridge();
    const { world } = await make({ bridge, ask: async () => 'no' });
    bridge.draft = '不发了';
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('没有发送');
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('refuses a text-based send control, even after a draft was typed', async () => {
    const bridge = new FakeBridge();
    const { world } = await make({ bridge, ask: yes });
    bridge.draft = '不应通过文本目标发送';
    const out = await run(world, 'browser_click', { text: '发送' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('编号');
    expect(bridge.calls.some((call) => call.op === 'click')).toBe(false);
  });

  it('refuses a numbered send control without a draft Coo wrote this turn', async () => {
    const bridge = new FakeBridge();
    const { world } = await make({ bridge, ask: yes });
    bridge.draft = '用户自己输入的内容';
    const out = await run(world, 'browser_click', { index: 3 });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('本轮由 Coo 填写');
    expect(bridge.calls.some((call) => call.op === 'click')).toBe(false);
  });

  it('leaves the Creator Center final Publish control for the person', async () => {
    const bridge = new FakeBridge();
    bridge.state = page({
      url: 'https://creator.douyin.com/creator-micro/content/upload',
      current: null,
      elements: [{ id: 2, label: '作品描述' }, { id: 3, label: '发布' }],
    });
    bridge.box = element({ placeholder: '作品描述' });
    bridge.button = element({ id: 3, tag: 'button', role: '', placeholder: '', label: '发布', text: '发布' });
    const { world } = await make({ bridge, ask: yes });
    await run(world, 'browser_type', { index: 2, text: '已经检查过的投稿文案' });

    const clicked = await run(world, 'browser_click', { index: 3 });
    expect(clicked.failed).toBe(true);
    expect(clicked.text).toContain('最终发布只能由你在浏览器窗口里亲自点击');
    const keyed = await run(world, 'browser_press', { index: 3, key: 'Enter' });
    expect(keyed.failed).toBe(true);
    expect(keyed.text).toContain('最终发布只能由你在浏览器窗口里亲自点击');
    expect(bridge.calls.some((call) => call.op === 'click' || call.op === 'press')).toBe(false);
  });

  it('refuses Enter or Space on a send button so it cannot skip the confirmation', async () => {
    const bridge = new FakeBridge();
    const { world } = await make({ bridge, ask: yes });
    for (const key of ['Enter', 'Space']) {
      const out = await run(world, 'browser_press', { index: 3, key });
      expect(out.failed).toBe(true);
      expect(out.text).toContain('编号');
    }
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('does not treat Space in a comment box as a send action', async () => {
    const bridge = new FakeBridge();
    let asked = 0;
    const { world } = await make({ bridge, ask: async () => { asked++; return 'yes'; } });
    bridge.draft = '未发送的草稿';
    const out = await run(world, 'browser_press', { index: 2, key: 'Space' });
    expect(out.failed).toBeUndefined();
    expect(asked).toBe(0);
    expect(bridge.draft).toBe('未发送的草稿');
  });

  it('sends nothing when the question times out or no bubble is there', async () => {
    const bridge = new FakeBridge();
    const timed = await make({ bridge, ask: async () => 'timeout' });
    bridge.draft = '等你';
    expect((await run(timed.world, 'browser_press', { index: 2, key: 'Enter' })).text).toContain('没有等到回应');
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);

    const silent = await make({ bridge });
    bridge.draft = '没人问';
    expect((await run(silent.world, 'browser_press', { index: 2, key: 'Enter' })).text).toContain('没有等到回应');
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('voids the confirmation when the text changes while the question is open', async () => {
    const bridge = new FakeBridge();
    let answer: (value: ApprovalAnswer) => void = () => {};
    let askedNow: () => void = () => {};
    const asked = new Promise<void>((resolve) => { askedNow = resolve; });
    const answerPromise = new Promise<ApprovalAnswer>((resolve) => { answer = resolve; });
    const { world } = await make({ bridge, ask: () => { askedNow(); return answerPromise; } });
    bridge.draft = '原来的话';
    const sending = run(world, 'browser_press', { index: 2, key: 'Enter' });
    await asked;
    bridge.draft = '被换掉的话';
    answer('yes');
    const out = await sending;
    expect(out.failed).toBe(true);
    expect(out.text).toContain('确认之后变了');
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('voids the confirmation when the signed-in account changes while it is open', async () => {
    const bridge = new FakeBridge();
    let answer: (value: ApprovalAnswer) => void = () => {};
    let askedNow: () => void = () => {};
    const asked = new Promise<void>((resolve) => { askedNow = resolve; });
    const answerPromise = new Promise<ApprovalAnswer>((resolve) => { answer = resolve; });
    const { world } = await make({ bridge, ask: () => { askedNow(); return answerPromise; } });
    bridge.draft = '账号绑定的内容';
    const sending = run(world, 'browser_press', { index: 2, key: 'Enter' });
    await asked;
    bridge.state.account = { ref: 'https://www.douyin.com/user/account-2', label: '我的主页' };
    answer('yes');
    const out = await sending;
    expect(out.failed).toBe(true);
    expect(out.text).toContain('确认之后变了');
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('refuses to send when the page cannot identify one signed-in account', async () => {
    let asked = 0;
    const bridge = new FakeBridge();
    bridge.state.account = null;
    const { world } = await make({ bridge, ask: async () => { asked++; return 'yes'; } });
    bridge.draft = '账号不明确';
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('无法绑定账号');
    expect(asked).toBe(0);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('keeps an unbound comment reply as a draft', async () => {
    const bridge = new FakeBridge();
    bridge.box.placeholder = '回复这条评论';
    let asked = 0;
    const { world } = await make({ bridge, ask: async () => { asked++; return 'yes'; } });
    bridge.draft = '回复内容';
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('没有可核对的评论目标');
    expect(asked).toBe(0);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('binds an approved reply to its comment and records the hash before resolving the action', async () => {
    const bridge = new FakeBridge();
    const fingerprint = 'a'.repeat(64), evidenceHash = 'b'.repeat(64);
    bridge.box = element({ placeholder: '回复评论' });
    bridge.state = page({ replyTargets: [{ boxId: 2, fingerprint, evidenceHash, author: '阿青', context: '阿青 这段配色好舒服', timestamp: '2026-10-28T03:00:00Z', needsExpand: false }], statusMessages: [] });
    bridge.replyStatusAfterPress = ['回复成功'];
    let question = '';
    const { world, dir, taskJournalFile } = await make({ bridge, ask: async (value) => { question = value; return 'yes'; } });
    await run(world, 'browser_type', { index: 2, text: '谢谢你喜欢这段配色' });
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(question).toContain('回复对象：阿青');
    expect(question).toContain('原评论：阿青 这段配色好舒服');
    expect(question).toContain('谢谢你喜欢这段配色');
    expect(out.failed).toBeUndefined();
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8'))).toEqual([{ fingerprint, sentAt: expect.any(Number) }]);
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))).toMatchObject([{ phase: 'verified', outcome: 'ui-observed' }]);
  });

  it('does not send a second reply to a comment already recorded', async () => {
    const bridge = new FakeBridge();
    const fingerprint = 'c'.repeat(64), evidenceHash = 'd'.repeat(64);
    bridge.box = element({ placeholder: '回复评论' });
    bridge.state = page({ replyTargets: [{ boxId: 2, fingerprint, evidenceHash, author: '阿青', context: '阿青 评论', timestamp: '', needsExpand: false }], statusMessages: ['回复成功'] });
    let asked = 0;
    const { world } = await make({ bridge, ask: async () => { asked++; return 'yes'; } });
    await run(world, 'browser_type', { index: 2, text: '第一条回复' });
    await run(world, 'browser_press', { index: 2, key: 'Enter' });
    await run(world, 'browser_type', { index: 2, text: '重复回复' });
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('已发送或待核对回复记录');
    expect(asked).toBe(1);
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
  });

  it('refuses comment replies when the durable duplicate guard is unavailable', async () => {
    const bridge = new FakeBridge();
    bridge.box = element({ placeholder: '回复评论' });
    bridge.state = page({ replyTargets: [{ boxId: 2, fingerprint: '4'.repeat(64), evidenceHash: '5'.repeat(64), author: '阿青', context: '阿青 评论', timestamp: '', needsExpand: false }] });
    let asked = 0;
    const { world } = await make({ bridge, replyJournalFile: null, ask: async () => { asked++; return 'yes'; } });
    await run(world, 'browser_type', { index: 2, text: '不应发出的回复' });
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('评论回复去重记录不可用');
    expect(asked).toBe(0);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('voids approval if the exact comment evidence changes while the question is open', async () => {
    const bridge = new FakeBridge();
    const fingerprint = 'e'.repeat(64), evidenceHash = 'f'.repeat(64);
    bridge.box = element({ placeholder: '回复评论' });
    bridge.state = page({ replyTargets: [{ boxId: 2, fingerprint, evidenceHash, author: '阿青', context: '原评论', timestamp: '', needsExpand: false }] });
    let answer: (value: ApprovalAnswer) => void = () => {};
    let askedNow: () => void = () => {};
    const asked = new Promise<void>((resolve) => { askedNow = resolve; });
    const answerPromise = new Promise<ApprovalAnswer>((resolve) => { answer = resolve; });
    const { world } = await make({ bridge, ask: () => { askedNow(); return answerPromise; } });
    await run(world, 'browser_type', { index: 2, text: '有依据的回复' });
    const sending = run(world, 'browser_press', { index: 2, key: 'Enter' });
    await asked;
    bridge.state.replyTargets![0] = { ...bridge.state.replyTargets![0]!, evidenceHash: '1'.repeat(64), context: '另一条评论' };
    answer('yes');
    const out = await sending;
    expect(out.failed).toBe(true);
    expect(out.text).toContain('确认之后变了');
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('requires the reply thread to be expanded and a reply-specific page receipt', async () => {
    const bridge = new FakeBridge();
    const fingerprint = '2'.repeat(64), evidenceHash = '3'.repeat(64);
    bridge.box = element({ placeholder: '回复评论' });
    bridge.state = page({ replyTargets: [{ boxId: 2, fingerprint, evidenceHash, author: '阿青', context: '阿青 评论', timestamp: '', needsExpand: true }] });
    let asked = 0;
    const { world, taskJournalFile } = await make({ bridge, ask: async () => { asked++; return 'yes'; } });
    await run(world, 'browser_type', { index: 2, text: '先展开再回复' });
    expect((await run(world, 'browser_press', { index: 2, key: 'Enter' })).text).toContain('回复列表尚未展开');
    expect(asked).toBe(0);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);

    bridge.state.replyTargets![0] = { ...bridge.state.replyTargets![0]!, needsExpand: false };
    bridge.state.statusMessages = [];
    await run(world, 'browser_read', {});
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.text).toContain('不确定这条内容有没有发出去');
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))).toMatchObject([{ phase: 'unknown', duplicateKey: expect.any(String) }]);
    await run(world, 'browser_type', { index: 2, text: '先展开再回复' });
    expect((await run(world, 'browser_press', { index: 2, key: 'Enter' })).text).toContain('已发送或待核对回复记录');
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
  });

  it('does not accept a reply success notice that was already visible before the action', async () => {
    const bridge = new FakeBridge();
    const fingerprint = '6'.repeat(64), evidenceHash = '7'.repeat(64);
    bridge.box = element({ placeholder: '回复评论' });
    bridge.state = page({ replyTargets: [{ boxId: 2, fingerprint, evidenceHash, author: '阿青', context: '阿青 评论', timestamp: '', needsExpand: false }], statusMessages: ['回复成功'] });
    const { world, dir, taskJournalFile } = await make({ bridge, ask: yes });
    await run(world, 'browser_type', { index: 2, text: '另一条回复' });
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.text).toContain('不确定这条内容有没有发出去');
    expect(JSON.parse(readFileSync(join(dir, 'replies.json'), 'utf8'))).toEqual([]);
    expect(JSON.parse(readFileSync(taskJournalFile, 'utf8'))).toMatchObject([{ phase: 'unknown', duplicateKey: expect.any(String) }]);
  });

  it('refuses to send when the record cannot be written first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-approval-'));
    tempDirs.push(dir);
    writeFileSync(join(dir, 'not-a-directory'), 'occupied');
    const bridge = new FakeBridge();
    const { world } = await make({ bridge, ask: yes, taskJournalFile: join(dir, 'not-a-directory', 'task-actions.json') });
    bridge.draft = '写不进磁盘';
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('发送记录不可用');
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
  });

  it('fails closed when the existing journal cannot be parsed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-approval-'));
    tempDirs.push(dir);
    const file = join(dir, 'actions.json');
    writeFileSync(file, '{broken');
    const bridge = new FakeBridge();
    let asked = 0;
    const { world } = await make({ bridge, ask: async () => { asked++; return 'yes'; }, journalFile: file });
    bridge.draft = '不能覆盖损坏日志';
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('发送记录不可用');
    expect(asked).toBe(0);
    expect(bridge.calls.some((call) => call.op === 'press')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{broken');
  });

  it('marks an unacknowledged send unknown and never presses twice', async () => {
    const bridge = new FakeBridge();
    bridge.failOn = 'press';
    const { world, taskJournalFile } = await make({ bridge, ask: yes });
    bridge.draft = '发出去了吗';
    const out = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('不确定这条内容有没有发出去');
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
    const left = JSON.parse(readFileSync(taskJournalFile, 'utf8'));
    expect(left).toHaveLength(1);
    expect(left[0].phase).toBe('unknown');
    expect(left[0].payloadDigest).toBe(hashContent('发出去了吗'));
    expect(left[0].content).toBeUndefined();
    await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
  });

  it('reports unknown when the box still shows the text', async () => {
    const bridge = new FakeBridge();
    bridge.draft = '还在这里';
    // the box is not cleared by this press
    (bridge as unknown as { call: (op: string, args?: Record<string, unknown>) => Promise<unknown> }).call = async (op, args = {}) => {
      bridge.calls.push({ op, args });
      if (op === 'element') return args.index === 3 ? bridge.button : bridge.box;
      if (op === 'draft') return bridge.draft;
      if (op === 'open' || op === 'read') return bridge.state;
      if (op === 'press') return { state: bridge.state };
      return bridge.state;
    };
    const { world } = await make({ bridge, ask: yes });
    expect((await run(world, 'browser_press', { index: 2, key: 'Enter' })).text).toContain('不确定');
  });

  it('asks again for the next post instead of reusing the approval', async () => {
    let asked = 0;
    const bridge = new FakeBridge();
    const { world } = await make({ bridge, ask: async () => { asked++; return 'yes'; } });
    bridge.draft = '第一条';
    await run(world, 'browser_press', { index: 2, key: 'Enter' });
    await run(world, 'browser_type', { index: 2, text: '第二条' });
    await run(world, 'browser_click', { index: 3 });
    expect(asked).toBe(2);
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.op === 'click')).toHaveLength(1);
  });

  it('holds one confirmation at a time', async () => {
    const bridge = new FakeBridge();
    let answer: (value: ApprovalAnswer) => void = () => {};
    let askedNow: () => void = () => {};
    const asked = new Promise<void>((resolve) => { askedNow = resolve; });
    const answerPromise = new Promise<ApprovalAnswer>((resolve) => { answer = resolve; });
    const { world } = await make({ bridge, ask: () => { askedNow(); return answerPromise; } });
    bridge.draft = '第一条';
    const first = run(world, 'browser_press', { index: 2, key: 'Enter' });
    await asked;
    const second = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(second.failed).toBe(true);
    expect(second.text).toContain('还在等你确认');
    answer('no');
    await first;
  });
});

describe('restart after an interrupted post', () => {
  it('migrates a left-over acting record and blocks the same text after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-approval-'));
    tempDirs.push(dir);
    const file = join(dir, 'actions.json');
    const content = '昨天那句话';
    const target = {
      surface: 'browser' as const,
      origin: 'https://www.douyin.com',
      url: 'https://www.douyin.com/video/123',
      videoUrl: 'https://www.douyin.com/video/123',
      videoTitle: '海边的下午',
      snapshotId: 'snapshot-1',
      control: '发送',
    };
    writeFileSync(file, JSON.stringify([{
      taskId: 't1', intent: 'send-text', phase: 'acting',
      target,
      contentHash: hashContent(content), contentLength: [...content].length,
      expectedEffect: 'the text appears on https://www.douyin.com',
      approval: { digest: actionDigest(target, content), issuedAt: 1, expiresAt: 2, used: true },
      createdAt: 1, updatedAt: 1,
    }]));
    const bridge = new FakeBridge();
    const pushed: Array<Record<string, unknown>> = [];
    const taskJournalFile = join(dir, 'task-actions.json');
    const world = new BrowserWorld({
      bridge,
      selfTime: () => ({ ...SELF_TIME_DEFAULTS, enabled: true, actions: true }),
      modelLanguage: () => 'zh',
      language: () => 'zh',
      timezone: 'Asia/Shanghai',
      journalFile: file,
      taskJournalFile,
    });
    await world.start(host(pushed));

    expect(pushed.map((event) => event.type)).toContain('browser.unresolved');
    expect(String(pushed[0].text)).toContain('不知道有没有发出去');
    const left = JSON.parse(readFileSync(taskJournalFile, 'utf8'));
    expect(left[0].phase).toBe('unknown');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);

    bridge.draft = content;
    await run(world, 'browser_open', { url: 'https://www.douyin.com/video/123' });
    const retry = await run(world, 'browser_press', { index: 2, key: 'Enter' });
    expect(retry.text).toContain('不确定这条内容有没有发出去');
    expect(bridge.calls.filter((call) => call.op === 'press')).toHaveLength(0);
  });
});
