import { describe, expect, it } from 'vitest';
import { isWorkspaceAppendPreapproved, parseWorkspaceAppendPaths, type WorkspaceAppendApprovalRequest } from '../core/workspace-append-approval.ts';

const root = '/tmp/coopanion-workspace';
const allowedPath = 'agenda/now-短.md';
const secondAllowedPath = 'agenda/now.md';
const allowedPaths = [allowedPath, secondAllowedPath];
const approval = (overrides: Partial<WorkspaceAppendApprovalRequest> = {}): WorkspaceAppendApprovalRequest => ({
  action: 'file-write',
  actionName: 'Persona append_file',
  expectedChange: `append ${allowedPath} sha256:${'a'.repeat(64)} (12 bytes)`,
  target: { surface: 'filesystem', workspaceRoot: root, path: allowedPath, operation: 'file-write', source: 'persona-workspace' },
  files: [{ path: allowedPath }],
  ...overrides,
});

describe('configured Persona workspace append path', () => {
  it('parses exact paths separated by semicolons or lines and rejects an unsafe list', () => {
    expect(parseWorkspaceAppendPaths(` ${allowedPath} `)).toEqual([allowedPath]);
    expect(parseWorkspaceAppendPaths(`${allowedPath}; ${secondAllowedPath}`)).toEqual(allowedPaths);
    expect(parseWorkspaceAppendPaths(`${allowedPath}\n${secondAllowedPath}\n`)).toEqual(allowedPaths);
    expect(parseWorkspaceAppendPaths('')).toEqual([]);
    expect(parseWorkspaceAppendPaths(null)).toEqual([]);
    expect(parseWorkspaceAppendPaths(`${allowedPath}; /tmp/outside.md`)).toEqual([]);
    expect(parseWorkspaceAppendPaths('../outside.md')).toEqual([]);
    expect(parseWorkspaceAppendPaths('agenda/../outside.md')).toEqual([]);
    expect(parseWorkspaceAppendPaths('agenda\\outside.md')).toEqual([]);
  });

  it('skips approval only for the configured Persona append in the matching workspace', () => {
    expect(isWorkspaceAppendPreapproved(approval(), root, allowedPaths, (path) => path)).toBe(true);
    const second = approval({
      expectedChange: `append ${secondAllowedPath} sha256:${'b'.repeat(64)} (12 bytes)`,
      target: { ...approval().target, path: secondAllowedPath },
      files: [{ path: secondAllowedPath }],
    });
    expect(isWorkspaceAppendPreapproved(second, root, allowedPaths, (path) => path)).toBe(true);
    expect(isWorkspaceAppendPreapproved(second, root, [allowedPath], (path) => path)).toBe(false);
  });

  it('keeps approval for edits, other paths, other workspaces and other writers', () => {
    expect(isWorkspaceAppendPreapproved(approval({ actionName: 'Persona edit_file' }), root, allowedPaths, (path) => path)).toBe(false);
    expect(isWorkspaceAppendPreapproved(approval({
      target: { ...approval().target, path: 'agenda/other.md' },
      expectedChange: `append agenda/other.md sha256:${'b'.repeat(64)} (12 bytes)`,
      files: [{ path: 'agenda/other.md' }],
    }), root, allowedPaths, (path) => path)).toBe(false);
    expect(isWorkspaceAppendPreapproved(approval({ target: { ...approval().target, workspaceRoot: '/tmp/other-workspace' } }), root, allowedPaths, (path) => path)).toBe(false);
    expect(isWorkspaceAppendPreapproved(approval({ target: { ...approval().target, source: 'opencode-acp' } }), root, allowedPaths, (path) => path)).toBe(false);
  });
});
