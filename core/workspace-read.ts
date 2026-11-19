/**
 * The label prepended to every workspace read.
 *
 * A workspace file is task material: it can support the current job, but it is not a verified
 * historical source. This is not a mode. After the W4 structural removal there is no `legacy`
 * branch that could present a file as remembered history. The only special case left is a forgotten
 * journal source: the file may still exist, but its history is fenced and the body is withheld.
 */
export function workspaceReadLabel(path: string): string {
  const encoded = JSON.stringify(path);
  return `[workspace artifact; path=${encoded}; historicalEvidence=unverified; workspaceMaterial=1] This file is workspace material, not a verified historical source. For a past shared event or decision, call memory_search with sources=true first; do not present this file as remembered history.`;
}

/**
 * The Bank document a workspace journal file represents, when one exists. This mapping never
 * grants a source and never writes memory; it exists only so a forgotten journal cannot come back
 * through the file that is still on disk.
 */
export function workspaceJournalSourceId(path: string): string | null {
  const normalized = path.replace(/\\/gu, '/').replace(/\/+/gu, '/');
  const match = normalized.match(/(?:^|\/)journal\/(\d{4}-\d{2}-\d{2})\.md$/u);
  return match ? `journal:${match[1]}` : null;
}

/** A read that must not return a forgotten journal's body, even though the file still exists. */
export function workspaceReadFencedLabel(path: string): string {
  return `[workspace artifact; path=${JSON.stringify(path)}; historicalEvidence=fenced; workspaceMaterial=1] This journal's remembered source was forgotten. The file still exists in the workspace, but its content is not available as history. Answer from other verified sources or say that the record is gone.`;
}
