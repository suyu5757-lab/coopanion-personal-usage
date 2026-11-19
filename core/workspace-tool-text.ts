/** Exact shapes of the Persona workspace tool's own result lines. */
import { createHash } from 'node:crypto';
import type { ToolOutcome } from 'cortico/core/types.ts';

const WORKSPACE_TOOLS = new Set(['write_file', 'append_file', 'edit_file', 'delete_file', 'save_blob']);
const WORKSPACE_READ_TOOLS = new Set(['read_file', 'list_files', 'glob_files', 'grep_files']);
const SUCCESS = /^\[(?:written|appended|edited|deleted|saved)\] \S(?:.*\S)?(?: \(unchanged\))?$/;
const FAILURE = /^\[(?:write|append|edit|delete|save) failed\] \S(?:.*\S)?$/;

/** How long a result line the Host itself issued stays available for source-map verification. */
const ISSUED_TTL_MS = 15 * 60_000;
const MAX_ISSUED = 512;

/**
 * True when the text is one of the workspace tool's fixed result lines rather than content the
 * model or a file supplied. The path in the line is still only a path: callers must not treat it
 * as a fact about the file's contents.
 */
export function isTrustedWorkspaceToolText(tool: string, text: string): boolean {
  if (!WORKSPACE_TOOLS.has(tool)) return false;
  if (text.includes('\n')) return false;
  return SUCCESS.test(text) || FAILURE.test(text);
}

/** The workspace tool's own line, declared as Core text so the next request can keep its mapping. */
export function workspaceToolOutcome(text: string): ToolOutcome {
  return {
    text,
    sourceMapSpans: [{ start: 0, end: text.length, digest: createHash('sha256').update(text).digest('hex'), origin: 'core-generated' }],
  };
}

/**
 * Remembers the workspace result lines this Host actually issued.
 *
 * A matching shape alone is not a receipt: a World, a model or a file can produce
 * `[written] self-review/x.md`. `toolTextTrust` therefore asks this ledger whether the exact line
 * came out of the Persona workspace tool before it is marked as Core-generated. Entries expire and
 * the ledger is bounded, so a stale line stops being trusted; an unknown line is never trusted.
 */
export class WorkspaceToolTextLedger {
  private readonly issued = new Map<string, { tool: string; at: number }>();
  /**
   * Exact workspace read results this Host composed. A read result is not a fixed receipt line:
   * it is local material the Host read and is about to show the model. The mark records only
   * that this Host issued these exact bytes; the label tells the model it is not history.
   */
  private readonly issuedReads = new Map<string, { tool: string; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Called only by the workspace tool itself, after it composed the line the model will see. */
  issue(tool: string, text: string): void {
    if (!isTrustedWorkspaceToolText(tool, text)) return;
    const at = this.now();
    this.issued.set(this.key(tool, text), { tool, at });
    if (this.issued.size <= MAX_ISSUED) return;
    for (const [key, entry] of this.issued) {
      if (at - entry.at > ISSUED_TTL_MS) this.issued.delete(key);
    }
    while (this.issued.size > MAX_ISSUED) {
      const oldest = this.issued.keys().next();
      if (oldest.done) break;
      this.issued.delete(oldest.value);
    }
  }

  /** True only when this Host issued this exact line recently and the tool still matches. */
  trust(tool: string, text: string): boolean {
    if (!isTrustedWorkspaceToolText(tool, text)) return false;
    const entry = this.issued.get(this.key(tool, text));
    if (!entry) return false;
    if (this.now() - entry.at > ISSUED_TTL_MS) {
      this.issued.delete(this.key(tool, text));
      return false;
    }
    return entry.tool === tool;
  }

  /** Called only by the workspace tool itself, after it composed a read result the model will see. */
  issueRead(tool: string, text: string): void {
    if (!WORKSPACE_READ_TOOLS.has(tool) || !text) return;
    const at = this.now();
    this.issuedReads.set(this.key(tool, text), { tool, at });
    if (this.issuedReads.size <= MAX_ISSUED) return;
    for (const [key, entry] of this.issuedReads) {
      if (at - entry.at > ISSUED_TTL_MS) this.issuedReads.delete(key);
    }
    while (this.issuedReads.size > MAX_ISSUED) {
      const oldest = this.issuedReads.keys().next();
      if (oldest.done) break;
      this.issuedReads.delete(oldest.value);
    }
  }

  /** True only when this Host issued this exact read result recently. */
  trustRead(tool: string, text: string): boolean {
    if (!WORKSPACE_READ_TOOLS.has(tool) || !text) return false;
    const entry = this.issuedReads.get(this.key(tool, text));
    if (!entry) return false;
    if (this.now() - entry.at > ISSUED_TTL_MS) {
      this.issuedReads.delete(this.key(tool, text));
      return false;
    }
    return entry.tool === tool;
  }

  private key(tool: string, text: string): string {
    return `${tool}\0${text}`;
  }
}
