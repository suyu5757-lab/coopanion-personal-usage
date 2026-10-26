/** What one opencode task leaves for the bot to review: its summary, changed files, commands and diffs. */
export interface ReviewFile {
  path: string;
  /** Lines added between the old and new text. */
  added: number;
  /** Lines removed between the old and new text. */
  removed: number;
}

export interface ReviewCommand {
  command: string;
  /** The tool call's last status. */
  status: string;
  /** The tail of the command's output. */
  output: string;
}

export interface ReviewDiff {
  path: string;
  oldText: string;
  newText: string;
}

export interface TaskReview {
  taskId: string;
  dir: string;
  sessionId: string;
  stop: string;
  /** The turn ended normally: the agent said it was finished. */
  ok: boolean;
  summary: string;
  files: ReviewFile[];
  commands: ReviewCommand[];
  diffs: ReviewDiff[];
}
