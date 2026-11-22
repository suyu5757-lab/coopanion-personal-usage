/** Matches configured Persona append paths without widening other workspace grants. */
export interface WorkspaceAppendApprovalRequest {
  action: string;
  actionName: string;
  expectedChange: string;
  target: {
    surface: string;
    workspaceRoot: string;
    path: string;
    operation: string;
    source: string;
  };
  files: readonly { path: string }[];
}

export function parseWorkspaceAppendPaths(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const paths = value.split(/[;\r\n]+/).map((path) => path.trim()).filter(Boolean);
  if (!paths.length) return [];
  if (paths.some((path) => path.startsWith('/') || path.includes('\\') || path.includes('\0')
    || path.split('/').some((part) => !part || part === '.' || part === '..'))) return [];
  return [...new Set(paths)];
}

export function isWorkspaceAppendPreapproved(
  request: WorkspaceAppendApprovalRequest,
  workspaceRoot: string,
  allowedPaths: readonly string[],
  canonicalRoot: (path: string) => string,
): boolean {
  if (!allowedPaths.includes(request.target.path) || request.action !== 'file-write' || request.actionName !== 'Persona append_file') return false;
  if (request.target.surface !== 'filesystem' || request.target.source !== 'persona-workspace'
    || request.target.operation !== 'file-write') return false;
  if (canonicalRoot(request.target.workspaceRoot) !== canonicalRoot(workspaceRoot)) return false;
  if (request.files.length !== 1 || request.files[0]?.path !== request.target.path) return false;
  return request.expectedChange.startsWith(`append ${request.target.path} sha256:`);
}
