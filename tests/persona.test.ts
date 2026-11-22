import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreApi, ToolDef } from 'cortico/core/types.ts';
import { Cormini } from '../vendor/cortico/bots/cormini/persona/persona.ts';
import { gitInstalled } from '../vendor/cortico/bots/cormini/persona/workspaceGit.ts';
import { AUTHOR_COO, PARTNER_DIR, PARTNER_FILE, PARTNER_NOTE, SNAPSHOT_TAG, arrangePartner, coopanionPersona } from '../core/persona.ts';
import { ActionGate } from '../core/action-gate.ts';
import { authorizeFileSystemAction } from '../core/action-authorization.ts';
import { ActionReceiptLedger, actionReceiptDuplicateKey } from '../core/action-receipts.ts';
import { partnerProvenancePath, partnerSegmentDigest, partnerWorkspaceDigest, writePartnerProvenance } from '../core/memory/partner-provenance.ts';

const CoopanionPersona = coopanionPersona(Cormini);
const ctx = { role: 'main', log: { emit: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } } as never;
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const toolText = (value: unknown): string => typeof value === 'string'
  ? value
  : String((value as { text?: unknown } | null)?.text ?? '');

function persona(growthStateFile?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'coo-persona-'));
  const Persona = growthStateFile ? coopanionPersona(Cormini, { growthStateFile }) : CoopanionPersona;
  const p = new Persona({ memoryDir: dir });
  const tool = (name: string): ToolDef => p.declareSessions()[0]!.tools().find((t) => t.name === name)!;
  return { dir, p, run: (name: string, args: Record<string, unknown>) => tool(name).handler(args, ctx) };
}

describe.skipIf(!gitInstalled())('Coo’s workspace history', () => {
  it('keeps Git metadata outside workspace file tools', async () => {
    const { dir, p, run } = persona();
    try {
      p.snapshot('1.0.0');
      symlinkSync('.git', join(dir, 'git-history'));

      expect(toolText(await run('read_file', { path: '.git/HEAD' }))).toContain('Git metadata is not available through workspace tools');
      expect(toolText(await run('read_file', { path: 'notes/../.git/HEAD' }))).toContain('Git metadata is not available through workspace tools');
      expect(toolText(await run('read_file', { path: 'git-history/HEAD' }))).toContain('Git metadata is not available through workspace tools');
      expect(toolText(await run('grep_files', { pattern: 'checkpoint0', path: '.git' }))).toContain('Git metadata is not available through workspace tools');
      expect(toolText(await run('glob_files', { glob_pattern: '*', target_directory: '.git' }))).toContain('Git metadata is not available through workspace tools');
      expect(toolText(await run('list_files', { dir: '.git' }))).toContain('Git metadata is not available through workspace tools');
      expect(toolText(await run('write_file', { path: '.git/HEAD', content: 'damaged' }))).toContain('Git metadata is not available through workspace tools');
      expect(toolText(await run('delete_file', { path: '.git/HEAD' }))).toContain('Git metadata is not available through workspace tools');
      rmSync(join(dir, 'git-history'));
      expect(git(dir, 'status', '--porcelain')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('commits each write Coo makes, as Coo, and nothing for a write that failed', async () => {
    const { dir, run } = persona();
    await run('write_file', { path: 'notes/today.md', content: 'tea' });
    await run('edit_file', { path: 'notes/today.md', old_string: 'tea', new_string: 'coffee' });
    await run('edit_file', { path: 'notes/today.md', old_string: 'absent', new_string: 'x' });
    expect(git(dir, 'log', '--format=%an|%s').split('\n')).toEqual([
      `${AUTHOR_COO.name}|Coo edited notes/today.md`,
      `${AUTHOR_COO.name}|Coo wrote notes/today.md`,
      expect.stringContaining('checkpoint0'),
    ]);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('snapshots the workspace once per version, with blobs/ out of the repository', async () => {
    const { dir, p } = persona();
    p.snapshot('1.0.0');
    // a blob committed before blobs/ was ignored, and a change made while the app was not running
    mkdirSync(join(dir, 'blobs'));
    writeFileSync(join(dir, 'blobs', 'cat.png'), 'png');
    git(dir, 'add', '-f', 'blobs/cat.png');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'blob');
    writeFileSync(join(dir, 'hand-edit.md'), 'edited by hand');
    p.snapshot('1.0.1');
    expect(git(dir, 'tag', '--list')).toContain(SNAPSHOT_TAG('1.0.1'));
    expect(git(dir, 'ls-files')).not.toContain('blobs/cat.png');
    expect(readFileSync(join(dir, 'blobs', 'cat.png'), 'utf8')).toBe('png');
    expect(git(dir, 'show', `${SNAPSHOT_TAG('1.0.1')}:hand-edit.md`)).toBe('edited by hand');
    // the same version again commits what changed since and makes no second tag
    writeFileSync(join(dir, 'hand-edit.md'), 'again');
    p.snapshot('1.0.1');
    expect(git(dir, 'tag', '--list').split('\n').filter((t) => t === SNAPSHOT_TAG('1.0.1'))).toHaveLength(1);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});

describe('PARTNER.md', () => {
  it('withholds a self-declared user-authored paragraph without a registered Memory source', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'coo-persona-app-state-'));
    const stateFile = join(stateDir, 'app-state', 'growth.json');
    const { dir: workspace, p, run } = persona(stateFile);
    try {
      await run('write_file', { path: PARTNER_FILE, content: 'Likes cats. Works late.' });
      const privateRoot = join(stateDir, 'app-state');
      writePartnerProvenance(partnerProvenancePath(privateRoot, workspace), {
        v: 1,
        workspaceDigest: partnerWorkspaceDigest(workspace),
        entries: [{
          id: '11111111111111111111111111111111',
          segmentDigest: partnerSegmentDigest('Likes cats. Works late.'),
          origin: 'user-authored',
          sourceIds: [],
          sourceScopeDigest: null,
          state: 'current',
        }],
      });
      const prefix = (await p.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] })).map((s) => s.text).join('\n');
      expect(prefix).not.toContain('Likes cats. Works late.');
      expect(prefix).toContain('Some PARTNER.md paragraphs are withheld');
      const read = await run('read_file', { path: PARTNER_FILE });
      const readText = typeof read === 'string' ? read : (read as { text?: string }).text ?? '';
      expect(readText).toContain('[read failed] PARTNER.md paragraphs are withheld');
      expect(readText).not.toContain('Likes cats. Works late.');
      const grep = toolText(await run('grep_files', { pattern: 'cats', path: '.' }));
      expect(grep).toContain('[search failed]');
      expect(grep).not.toContain('Likes cats.');
      expect(toolText(await run('delete_file', { path: PARTNER_FILE }))).toContain('[delete failed]');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it('labels ordinary workspace reads while preserving them for project work', async () => {
    const { dir, run } = persona();
    try {
      mkdirSync(join(dir, 'agenda'));
      writeFileSync(join(dir, 'agenda', 'now.md'), 'Synthetic task note: prepare the project outline.');

      const read = toolText(await run('read_file', { path: 'agenda/now.md' }));
      const search = toolText(await run('grep_files', { pattern: 'project outline', path: 'agenda' }));

      expect(read).toContain('[workspace artifact; path="agenda/now.md"; historicalEvidence=unverified; workspaceMaterial=1]');
      expect(read).toContain('Synthetic task note: prepare the project outline.');
      expect(search).toContain('[workspace artifact; path="agenda"; historicalEvidence=unverified; workspaceMaterial=1]');
      expect(search).toContain('Synthetic task note: prepare the project outline.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('withholds legacy paragraphs when their sidecar is missing', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'coo-persona-state-'));
    const { dir, p, run } = persona(join(stateDir, 'growth.json'));
    try {
      await run('write_file', { path: PARTNER_FILE, content: 'Legacy private note.' });
      const prefix = (await p.systemSegments({ now: new Date(), timezone: 'UTC', worlds: [] })).map((s) => s.text).join('\n');
      expect(prefix).not.toContain('Legacy private note.');
      expect(prefix).toContain('provenance sidecar is missing');
      expect(prefix).toContain('unknown, not false');
      expect(toolText(await run('read_file', { path: PARTNER_FILE }))).not.toContain('Legacy private note.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

/** Whether this file system tells `a` and `A` apart; the case-variant merges only arise where it does. */
function caseSensitive(): boolean {
  const dir = mkdtempSync(join(tmpdir(), 'coo-case-'));
  writeFileSync(join(dir, 'a'), '');
  return !existsSync(join(dir, 'A'));
}

describe('arranging the partner notes', () => {
  it('moves a file named partner into the partner directory and leaves PARTNER.md as it was', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-partner-'));
    writeFileSync(join(dir, PARTNER_FILE), 'Likes cats.');
    writeFileSync(join(dir, PARTNER_DIR), 'old notes');
    expect(arrangePartner(dir)).toBe(true);
    expect(statSync(join(dir, PARTNER_DIR)).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, PARTNER_DIR, PARTNER_DIR), 'utf8')).toBe('old notes');
    expect(readFileSync(join(dir, PARTNER_FILE), 'utf8')).toBe('Likes cats.');
    expect(arrangePartner(dir)).toBe(false);
  });

  it('renames a partner.md Coo wrote before to PARTNER.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-partner-'));
    writeFileSync(join(dir, 'partner.md'), 'Works late.');
    expect(arrangePartner(dir)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([PARTNER_FILE, PARTNER_DIR].sort());
    expect(readFileSync(join(dir, PARTNER_FILE), 'utf8')).toBe('Works late.');
  });

  it.skipIf(!caseSensitive())('merges a partner.md and a Partner directory left beside the real ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coo-partner-'));
    writeFileSync(join(dir, PARTNER_FILE), 'Likes cats.');
    writeFileSync(join(dir, 'partner.md'), 'Works late.');
    mkdirSync(join(dir, PARTNER_DIR));
    writeFileSync(join(dir, PARTNER_DIR, 'trips.md'), 'Kyoto');
    mkdirSync(join(dir, 'Partner'));
    writeFileSync(join(dir, 'Partner', 'trips.md'), 'Osaka');
    expect(arrangePartner(dir)).toBe(true);
    expect(readFileSync(join(dir, PARTNER_FILE), 'utf8')).toContain('Likes cats.');
    expect(readFileSync(join(dir, PARTNER_FILE), 'utf8')).toContain('Works late.');
    expect(readdirSync(dir).sort()).toEqual([PARTNER_FILE, PARTNER_DIR].sort());
    expect(readdirSync(join(dir, PARTNER_DIR)).sort()).toEqual(['Partner-trips.md', 'trips.md']);
  });

  it.skipIf(!gitInstalled())('commits the arranging after the start tag, so the tag keeps the workspace as it was', () => {
    const { dir, p } = persona();
    writeFileSync(join(dir, PARTNER_DIR), 'old notes');
    p.snapshot('2.0.0');
    expect(git(dir, 'show', `${SNAPSHOT_TAG('2.0.0')}:${PARTNER_DIR}`)).toBe('old notes');
    expect(git(dir, 'show', `HEAD:${PARTNER_DIR}/${PARTNER_DIR}`)).toBe('old notes');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});

describe('Core-gated Persona workspace writes', () => {
  function gatedPersona(confirm: () => Promise<boolean>) {
    const dir = mkdtempSync(join(tmpdir(), 'coo-persona-gated-'));
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const receiptFile = join(dir, 'action-receipts.json');
    const ledger = new ActionReceiptLedger(receiptFile);
    const gate = new ActionGate({
      platformWrites: () => false,
      imageGeneration: () => false,
      imageSaving: () => false,
      mediaUpload: () => false,
      computerInput: () => false,
      desktopTargetAllowed: () => false,
      fileSystemActionAllowed: (target, action) => target.surface === 'filesystem'
        && target.source === 'persona-workspace'
        && target.operation === action
        && target.workspaceRoot === realpathSync(workspace),
      fileSystemPermissionGeneration: () => workspace,
    });
    const GatedPersona = coopanionPersona(Cormini, {
      authorizeWorkspaceAction: (request) => authorizeFileSystemAction(ledger, gate, request, confirm),
      actionReceipts: () => ledger,
    });
    const p = new GatedPersona({ memoryDir: workspace });
    const run = (name: string, args: Record<string, unknown>) => {
      const tool = p.declareSessions()[0]!.tools().find((entry) => entry.name === name)!;
      return tool.handler(args, ctx);
    };
    const receipts = () => JSON.parse(readFileSync(receiptFile, 'utf8')) as Array<Record<string, unknown>>;
    return { dir, workspace, p, run, receipts, ledger };
  }

  it('waits for Core approval, binds exact bytes and verifies the written file', async () => {
    let decide!: (approved: boolean) => void;
    const { dir, workspace, run, receipts } = gatedPersona(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    try {
      const file = join(workspace, 'notes', 'today.md');
      const pending = run('write_file', { path: 'notes/today.md', content: 'tea and coffee' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(existsSync(file)).toBe(false);
      expect(receipts()[0]).toMatchObject({ phase: 'awaiting-approval', intent: 'file-write', target: { surface: 'filesystem', path: 'notes/today.md', source: 'persona-workspace' } });

      decide(true);
      expect(await pending).toContain('[written] notes/today.md');
      expect(readFileSync(file, 'utf8')).toBe('tea and coffee');
      expect(receipts()[0]).toMatchObject({ phase: 'verified', dispatchState: 'delivered', outcome: 'ui-observed', files: [{ digest: expect.any(String), bytes: 14 }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not initialize workspace history or dispatch when Core rejects the grant', async () => {
    const { dir, workspace, run, receipts } = gatedPersona(async () => false);
    try {
      const result = await run('write_file', { path: 'blocked.md', content: 'no' });
      expect(String(result)).toContain('Core did not authorize');
      expect(existsSync(join(workspace, 'blocked.md'))).toBe(false);
      expect(existsSync(join(workspace, '.git'))).toBe(false);
      expect(receipts()[0]).toMatchObject({ phase: 'cancelled', outcome: 'cancelled' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlink paths that leave the Persona workspace before asking for approval', async () => {
    let confirmations = 0;
    const { dir, workspace, run } = gatedPersona(async () => { confirmations++; return true; });
    try {
      const outside = join(dir, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, join(workspace, 'outside'));
      const result = await run('write_file', { path: 'outside/private.md', content: 'blocked' });
      expect(String(result)).toContain('resolves outside the workspace');
      expect(confirmations).toBe(0);
      expect(existsSync(join(outside, 'private.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('checks the approved preimage before editing, appending or deleting', async () => {
    let alterBeforeApproval = false;
    const { dir, workspace, run, receipts } = gatedPersona(async () => {
      if (alterBeforeApproval) writeFileSync(join(workspace, 'note.md'), 'changed elsewhere');
      return true;
    });
    try {
      writeFileSync(join(workspace, 'note.md'), 'today');
      expect(await run('append_file', { path: 'note.md', content: 'next' })).toContain('[appended]');
      expect(readFileSync(join(workspace, 'note.md'), 'utf8')).toBe('today\nnext');
      expect(await run('edit_file', { path: 'note.md', old_string: 'today', new_string: 'yesterday' })).toContain('[edited]');
      expect(readFileSync(join(workspace, 'note.md'), 'utf8')).toBe('yesterday\nnext');
      expect(await run('delete_file', { path: 'note.md' })).toContain('[deleted]');
      expect(existsSync(join(workspace, 'note.md'))).toBe(false);
      expect(receipts().slice(-3).map((receipt) => receipt.phase)).toEqual(['verified', 'verified', 'verified']);

      writeFileSync(join(workspace, 'note.md'), 'approved content');
      alterBeforeApproval = true;
      expect(toolText(await run('write_file', { path: 'note.md', content: 'new content' }))).toContain('changed before dispatch');
      expect(readFileSync(join(workspace, 'note.md'), 'utf8')).toBe('changed elsewhere');
      expect(receipts().at(-1)).toMatchObject({ phase: 'cancelled', outcome: 'cancelled' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('authorizes save_blob against its effective blobs path and verifies the copied bytes', async () => {
    const { dir, workspace, p, run, receipts } = gatedPersona(async () => true);
    try {
      p.attach({ blob: () => ({ bytes: Buffer.from([1, 2, 3, 4]), mime: 'image/png' }) } as unknown as CoreApi);
      expect(await run('save_blob', { handle: 'abcdef12', path: 'cat.png' })).toContain('[saved] mem:blobs/cat.png');
      expect(readFileSync(join(workspace, 'blobs', 'cat.png'))).toEqual(Buffer.from([1, 2, 3, 4]));
      expect(receipts()[0]).toMatchObject({ phase: 'verified', target: { path: 'blobs/cat.png' }, files: [{ bytes: 4, mime: 'image/png' }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exposes unresolved shared receipts to Persona WebUI and records an operator reconciliation', async () => {
    const { dir, workspace, p, ledger } = gatedPersona(async () => true);
    try {
      const target = {
        surface: 'filesystem' as const,
        instanceId: 'persona-review-test',
        workspaceRoot: realpathSync(workspace),
        path: 'note.md',
        operation: 'file-write' as const,
        snapshotId: 'before-write',
        source: 'persona-workspace' as const,
      };
      const payloadDigest = 'a'.repeat(64);
      const receipt = ledger.begin({
        taskId: 'persona-review-test',
        intent: 'file-write',
        action: 'Persona write_file',
        risk: 'REVERSIBLE_LOCAL',
        target,
        payloadDigest,
        files: [{ path: 'note.md', digest: payloadDigest, bytes: 4, mime: 'text/plain' }],
        duplicateKey: actionReceiptDuplicateKey('file-write', target, payloadDigest),
      }, 5_000);
      ledger.awaitingApproval(receipt.id, 5_001);
      ledger.acting(receipt.id, 'b'.repeat(64), 5_002, 30_000, 5_003);
      ledger.complete(receipt.id, { phase: 'unknown', dispatchState: 'delivered', outcome: 'unknown', note: 'read-back unavailable' }, 5_004);

      const webUi = p.webUi('en');
      expect(webUi.memory?.panels).toContainEqual(expect.objectContaining({ id: 'action-receipts' }));
      const list = await webUi.invoke!('action-receipts', 'list', []) as { available: boolean; receipts: Array<{ id: string; phase: string }> };
      expect(list).toMatchObject({ available: true, receipts: [{ id: receipt.id, phase: 'unknown' }] });
      await webUi.invoke!('action-receipts', 'reconcile', [receipt.id, 'verified', 'I checked the workspace and confirmed the approved contents.']);
      const cleared = await webUi.invoke!('action-receipts', 'list', []) as { receipts: unknown[] };
      expect(cleared.receipts).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
