/**
 * Durable task continuation journal built alongside ActionReceiptLedger.
 * Tracks minimal, content-free step progress, monotonic generation/epoch fences,
 * restart recovery without duplicating verified side effects, and late-receipt isolation.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeState } from './state-file.ts';

export type ContinuationTaskStatus = 'active' | 'paused' | 'cancelled' | 'blocked' | 'completed';
export type ContinuationStepStatus = 'planned' | 'dispatched' | 'unknown' | 'verified' | 'skipped' | 'cancelled' | 'blocked';

export interface ContinuationTargetRef {
  surface: 'desktop' | 'browser' | 'filesystem';
  bundleId?: string;
  windowTitle?: string;
  path?: string;
  snapshotRef?: string;
}

export interface ContinuationStep {
  stepId: string;
  intent: string;
  tool: string;
  target: ContinuationTargetRef;
  payloadDigest: string;
  status: ContinuationStepStatus;
  receiptId?: string;
  externalCheckDigest?: string;
  note?: string;
  updatedAt: number;
}

export interface ContinuationTask {
  taskId: string;
  objectiveDigest: string;
  scope: string;
  allowedImpact: string[];
  generation: number;
  status: ContinuationTaskStatus;
  steps: ContinuationStep[];
  resumeCursor: number;
  createdAt: number;
  updatedAt: number;
}

export type ExternalVerificationResult =
  | { state: 'verified'; digest: string; note?: string }
  | { state: 'not-executed'; note?: string }
  | { state: 'unknown'; note?: string }
  | { state: 'target-changed'; note?: string };

export interface ResumeDecision {
  taskId: string;
  generation: number;
  skippedStepIds: string[];
  nextStep: ContinuationStep | null;
  blockedStepId: string | null;
  status: ContinuationTaskStatus;
}

const MAX_RECENT_TASKS = 200;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function lastVerifiedIndex(steps: readonly ContinuationStep[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i]!.status === 'verified') return i;
  }
  return -1;
}

function computeResumeCursor(steps: readonly ContinuationStep[]): number {
  const afterVerified = lastVerifiedIndex(steps);
  const start = afterVerified >= 0 ? afterVerified + 1 : 0;
  for (let i = start; i < steps.length; i++) {
    const status = steps[i]!.status;
    if (status !== 'verified' && status !== 'skipped') return i;
  }
  return steps.length;
}

export class TaskContinuationJournal {
  private tasks: ContinuationTask[];

  constructor(private readonly file: string) {
    if (!existsSync(file)) {
      this.tasks = [];
    } else {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) throw new Error('the task continuation journal is invalid');
      this.tasks = parsed as ContinuationTask[];
    }
  }

  getTask(taskId: string): ContinuationTask | null {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    return task ? structuredClone(task) : null;
  }

  listTasks(): ContinuationTask[] {
    return structuredClone(this.tasks);
  }

  /** Returns the latest interrupted, non-cancelled task that still has unverified steps. */
  findResumableTask(): ContinuationTask | null {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      const task = this.tasks[i]!;
      if ((task.status === 'active' || task.status === 'paused') && task.resumeCursor < task.steps.length) {
        return structuredClone(task);
      }
    }
    return null;
  }

  /** Finds the first matching planned step so resumed execution updates it in-place instead of duplicating. */
  findPlannedStep(taskId: string, tool: string, bundleId?: string): ContinuationStep | null {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task || task.status === 'cancelled') return null;
    const match = task.steps.find((step) => step.status === 'planned'
      && (!bundleId || !step.target.bundleId || step.target.bundleId === bundleId)
      && (!step.tool || step.tool === tool || step.tool === 'any'));
    return match ? structuredClone(match) : null;
  }

  ensureTask(input: {
    taskId: string;
    objective: string;
    scope: string;
    allowedImpact: string[];
  }, now = Date.now()): ContinuationTask {
    const existing = this.tasks.find((candidate) => candidate.taskId === input.taskId);
    if (existing) return structuredClone(existing);
    const task: ContinuationTask = {
      taskId: input.taskId,
      objectiveDigest: sha256(input.objective),
      scope: input.scope.slice(0, 120),
      allowedImpact: [...input.allowedImpact],
      generation: 1,
      status: 'active',
      steps: [],
      resumeCursor: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.push(task);
    this.save();
    return structuredClone(task);
  }

  planStep(taskId: string, input: {
    stepId: string;
    intent: string;
    tool: string;
    target: ContinuationTargetRef;
    payloadDigest: string;
  }, now = Date.now()): ContinuationStep | null {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task || task.status === 'cancelled') return null;
    const existing = task.steps.find((candidate) => candidate.stepId === input.stepId);
    if (existing) return structuredClone(existing);
    const step: ContinuationStep = {
      stepId: input.stepId,
      intent: input.intent.slice(0, 120),
      tool: input.tool.slice(0, 120),
      target: structuredClone(input.target),
      payloadDigest: input.payloadDigest,
      status: 'planned',
      updatedAt: now,
    };
    task.steps.push(step);
    if (task.status === 'completed') task.status = 'active';
    task.resumeCursor = computeResumeCursor(task.steps);
    task.updatedAt = now;
    this.save();
    return structuredClone(step);
  }

  markDispatched(taskId: string, stepId: string, receiptId: string, epoch: number, now = Date.now()): boolean {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task || task.status === 'cancelled' || task.generation !== epoch) return false;
    const step = task.steps.find((candidate) => candidate.stepId === stepId);
    if (!step || step.status === 'verified' || step.status === 'cancelled') return false;
    step.status = 'dispatched';
    step.receiptId = receiptId;
    step.updatedAt = now;
    task.resumeCursor = computeResumeCursor(task.steps);
    task.updatedAt = now;
    this.save();
    return true;
  }

  /**
   * Records a receipt result only if the task is still active/paused and the epoch matches.
   * Late receipts from cancelled tasks or stale epochs are strictly ignored so they never
   * resurrect a cancelled task or corrupt a newer generation.
   */
  recordReceipt(
    taskId: string,
    stepId: string,
    epoch: number,
    result: {
      status: 'verified' | 'unknown' | 'cancelled' | 'blocked';
      externalCheckDigest?: string;
      note?: string;
    },
    now = Date.now(),
  ): { applied: boolean; reason?: string } {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) return { applied: false, reason: 'task-not-found' };
    if (task.status === 'cancelled') return { applied: false, reason: 'task-cancelled' };
    if (task.generation !== epoch) return { applied: false, reason: 'stale-generation' };
    const step = task.steps.find((candidate) => candidate.stepId === stepId);
    if (!step) return { applied: false, reason: 'step-not-found' };
    if (step.status === 'verified') return { applied: false, reason: 'already-verified' };
    step.status = result.status;
    if (result.externalCheckDigest) step.externalCheckDigest = result.externalCheckDigest;
    if (result.note) step.note = result.note.slice(0, 300);
    step.updatedAt = now;
    task.resumeCursor = computeResumeCursor(task.steps);
    if (task.steps.length > 0 && task.resumeCursor >= task.steps.length) {
      task.status = 'completed';
    }
    task.updatedAt = now;
    this.save();
    return { applied: true };
  }

  /**
   * Cancels a task immediately: increments generation/epoch so any in-flight or late receipt
   * from the previous epoch is fenced off and cannot resurrect or mutate task state.
   */
  cancelTask(taskId: string, note = 'cancelled by user', now = Date.now()): number | null {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) return null;
    task.generation += 1;
    task.status = 'cancelled';
    for (const step of task.steps) {
      if (step.status === 'planned' || step.status === 'dispatched') {
        step.status = 'cancelled';
        step.note = note.slice(0, 300);
        step.updatedAt = now;
      }
    }
    task.updatedAt = now;
    this.save();
    return task.generation;
  }

  /**
   * Called on Core/Driver restart: preserves `verified` steps as-is, transitions any in-flight
   * `dispatched` steps to `unknown` (requiring read-only external verification before retry),
   * and keeps `cancelled` tasks cancelled.
   */
  recoverAfterRestart(now = Date.now()): { unknownSteps: number; resumableTasks: number } {
    let changed = false;
    let unknownSteps = 0;
    let resumableTasks = 0;
    for (const task of this.tasks) {
      if (task.status === 'cancelled' || task.status === 'completed') continue;
      for (const step of task.steps) {
        if (step.status === 'dispatched') {
          step.status = 'unknown';
          step.note = 'process restarted before step verification; read-only check required';
          step.updatedAt = now;
          changed = true;
        }
        if (step.status === 'unknown') unknownSteps += 1;
      }
      task.resumeCursor = computeResumeCursor(task.steps);
      if (task.resumeCursor < task.steps.length) resumableTasks += 1;
    }
    if (changed) this.save();
    return { unknownSteps, resumableTasks };
  }

  /**
   * Computes the safe resume plan for a task after restart:
   * - `verified` / `skipped` steps are skipped without re-dispatch.
   * - `unknown` / `dispatched` steps MUST be checked via read-only `verifyExternal` first:
   *   - if verified externally -> mark `verified` and skip.
   *   - if confirmed not-executed -> mark `planned` (eligible for safe low-risk retry).
   *   - if target changed -> mark `blocked` (preserve prior verified steps).
   *   - if still unknown -> keep `unknown` and block blind retry.
   */
  async planResume(
    taskId: string,
    verifyExternal?: (step: ContinuationStep) => Promise<ExternalVerificationResult>,
    now = Date.now(),
  ): Promise<ResumeDecision | null> {
    const task = this.tasks.find((candidate) => candidate.taskId === taskId);
    if (!task) return null;
    if (task.status === 'cancelled') {
      return { taskId, generation: task.generation, skippedStepIds: [], nextStep: null, blockedStepId: null, status: 'cancelled' };
    }
    const skippedStepIds: string[] = [];
    let nextStep: ContinuationStep | null = null;
    let blockedStepId: string | null = null;
    let changed = false;

    const lastVerified = lastVerifiedIndex(task.steps);
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]!;
      if (step.status === 'verified' || step.status === 'skipped') {
        skippedStepIds.push(step.stepId);
        continue;
      }
      if (i < lastVerified && step.status === 'unknown') {
        step.status = 'skipped';
        step.note = 'superseded by later verified step in same task';
        step.updatedAt = now;
        skippedStepIds.push(step.stepId);
        changed = true;
        continue;
      }
      if (step.status === 'unknown' || step.status === 'dispatched') {
        if (!verifyExternal) {
          step.status = 'unknown';
          blockedStepId = step.stepId;
          changed = true;
          break;
        }
        const check = await verifyExternal(structuredClone(step));
        if (check.state === 'verified') {
          step.status = 'verified';
          step.externalCheckDigest = check.digest;
          step.note = (check.note ?? 'verified via read-only external check').slice(0, 300);
          step.updatedAt = now;
          skippedStepIds.push(step.stepId);
          changed = true;
          continue;
        }
        if (check.state === 'not-executed') {
          step.status = 'planned';
          step.note = (check.note ?? 'confirmed not executed; eligible for safe retry').slice(0, 300);
          step.updatedAt = now;
          nextStep = structuredClone(step);
          changed = true;
          break;
        }
        if (check.state === 'target-changed') {
          step.status = 'blocked';
          step.note = (check.note ?? 'target identity changed; paused step').slice(0, 300);
          step.updatedAt = now;
          blockedStepId = step.stepId;
          changed = true;
          break;
        }
        step.status = 'unknown';
        step.note = (check.note ?? 'external state remains unknown; blind retry refused').slice(0, 300);
        step.updatedAt = now;
        blockedStepId = step.stepId;
        changed = true;
        break;
      }
      if (step.status === 'planned') {
        nextStep = structuredClone(step);
        break;
      }
      if (step.status === 'blocked') {
        blockedStepId = step.stepId;
        break;
      }
    }

    task.resumeCursor = computeResumeCursor(task.steps);
    if (!nextStep && !blockedStepId && task.steps.length > 0 && task.resumeCursor >= task.steps.length) {
      task.status = 'completed';
      changed = true;
    } else if (blockedStepId) {
      task.status = 'blocked';
      changed = true;
    }
    if (changed) {
      task.updatedAt = now;
      this.save();
    }
    return {
      taskId,
      generation: task.generation,
      skippedStepIds,
      nextStep,
      blockedStepId,
      status: task.status,
    };
  }

  private save(): void {
    if (this.tasks.length > MAX_RECENT_TASKS) {
      const open = this.tasks.filter((t) => t.status === 'active' || t.status === 'paused' || t.status === 'blocked');
      const settledLimit = Math.max(0, MAX_RECENT_TASKS - open.length);
      const settled = settledLimit === 0
        ? []
        : this.tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled').slice(-settledLimit);
      const retained = new Set([...open, ...settled].map((t) => t.taskId));
      this.tasks = this.tasks.filter((t) => retained.has(t.taskId));
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeState(this.file, `${JSON.stringify(this.tasks, null, 2)}\n`);
  }
}
