import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskContinuationJournal } from '../core/task-continuation.ts';

const dirs: string[] = [];
const makeFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'coopanion-task-journal-'));
  dirs.push(dir);
  return join(dir, 'task-journal.json');
};

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('TaskContinuationJournal (R4-C)', () => {
  it('skips verified steps on restart, checks unknown steps read-only, and never duplicates verified writes', async () => {
    const file = makeFile();
    const journal1 = new TaskContinuationJournal(file);
    const task = journal1.ensureTask({
      taskId: 'task-r4c-1',
      objective: 'Write TextEdit and inspect in Finder',
      scope: 'desktop-ordinary-cua',
      allowedImpact: ['computer-input'],
    }, 1_000);
    journal1.planStep(task.taskId, {
      stepId: 'step-1-type',
      intent: 'computer-input',
      tool: 'pet_cua_type',
      target: { surface: 'desktop', bundleId: 'com.apple.TextEdit', path: '/tmp/test.txt' },
      payloadDigest: 'a'.repeat(64),
    }, 1_001);
    journal1.planStep(task.taskId, {
      stepId: 'step-2-save',
      intent: 'computer-input',
      tool: 'pet_cua_key',
      target: { surface: 'desktop', bundleId: 'com.apple.TextEdit', path: '/tmp/test.txt' },
      payloadDigest: 'b'.repeat(64),
    }, 1_002);
    journal1.planStep(task.taskId, {
      stepId: 'step-3-finder',
      intent: 'computer-input',
      tool: 'pet_cua_accessibility',
      target: { surface: 'desktop', bundleId: 'com.apple.finder' },
      payloadDigest: 'c'.repeat(64),
    }, 1_003);

    expect(journal1.markDispatched(task.taskId, 'step-1-type', 'rcpt-1', task.generation, 1_004)).toBe(true);
    expect(journal1.recordReceipt(task.taskId, 'step-1-type', task.generation, {
      status: 'verified', externalCheckDigest: '1'.repeat(64), note: 'disk sha matched',
    }, 1_005)).toEqual({ applied: true });
    // Step 2 was dispatched right before crash/restart (no completion receipt yet)
    expect(journal1.markDispatched(task.taskId, 'step-2-save', 'rcpt-2', task.generation, 1_006)).toBe(true);

    // Simulate Core/Driver restart loading from disk
    const journal2 = new TaskContinuationJournal(file);
    const recovery = journal2.recoverAfterRestart(2_000);
    expect(recovery).toEqual({ unknownSteps: 1, resumableTasks: 1 });
    expect(journal2.getTask(task.taskId)?.steps.map((s) => s.status)).toEqual(['verified', 'unknown', 'planned']);

    // Without external verification, unknown must NOT be auto-promoted to verified
    const blocked = await journal2.planResume(task.taskId, async () => ({ state: 'unknown', note: 'still unreadable' }), 2_001);
    expect(blocked?.skippedStepIds).toEqual(['step-1-type']);
    expect(blocked?.blockedStepId).toBe('step-2-save');
    expect(blocked?.nextStep).toBeNull();

    // Once read-only external check confirms file bytes are already saved, step-2 is verified and resume advances to step-3
    const resumed = await journal2.planResume(task.taskId, async (step) => {
      expect(step.stepId).toBe('step-2-save');
      return { state: 'verified', digest: '2'.repeat(64), note: 'disk sha confirmed saved' };
    }, 2_002);
    expect(resumed?.skippedStepIds).toEqual(['step-1-type', 'step-2-save']);
    expect(resumed?.nextStep?.stepId).toBe('step-3-finder');
    expect(resumed?.blockedStepId).toBeNull();
  });

  it('fences late receipts after cancellation so old receipts never resurrect or pollute a new task', async () => {
    const file = makeFile();
    const journal = new TaskContinuationJournal(file);
    const oldTask = journal.ensureTask({
      taskId: 'task-cancel-old',
      objective: 'Old task',
      scope: 'desktop-ordinary-cua',
      allowedImpact: ['computer-input'],
    }, 1_000);
    journal.planStep(oldTask.taskId, {
      stepId: 'step-old-1',
      intent: 'computer-input',
      tool: 'pet_cua_type',
      target: { surface: 'desktop', bundleId: 'com.apple.TextEdit' },
      payloadDigest: 'd'.repeat(64),
    }, 1_001);
    expect(journal.markDispatched(oldTask.taskId, 'step-old-1', 'rcpt-old', oldTask.generation, 1_002)).toBe(true);

    // User cancels old task -> generation advances and task is marked cancelled
    const cancelledEpoch = journal.cancelTask(oldTask.taskId, 'user cancelled', 1_003);
    expect(cancelledEpoch).toBe(2);

    // Late receipt arrives with old generation -> strictly rejected
    const late = journal.recordReceipt(oldTask.taskId, 'step-old-1', oldTask.generation, {
      status: 'verified', externalCheckDigest: '9'.repeat(64), note: 'late receipt',
    }, 1_010);
    expect(late).toEqual({ applied: false, reason: 'task-cancelled' });
    expect(journal.getTask(oldTask.taskId)?.status).toBe('cancelled');
    expect(journal.getTask(oldTask.taskId)?.steps[0]?.status).toBe('cancelled');
    expect(await journal.planResume(oldTask.taskId)).toMatchObject({ status: 'cancelled', nextStep: null });

    // New task runs cleanly without pollution from old task
    const newTask = journal.ensureTask({
      taskId: 'task-new-clean',
      objective: 'New task',
      scope: 'desktop-ordinary-cua',
      allowedImpact: ['computer-input'],
    }, 1_020);
    expect(newTask.status).toBe('active');
    expect(newTask.generation).toBe(1);
  });

  it('distinguishes shutdown suspension from explicit cancel and restores the same taskId for planned step B', async () => {
    const file = makeFile();
    const journal1 = new TaskContinuationJournal(file);
    const task = journal1.ensureTask({
      taskId: 'task-restart-continue-1',
      objective: 'Step A verified then restart then Step B in Finder',
      scope: 'desktop-ordinary-cua',
      allowedImpact: ['computer-input'],
    }, 1_000);
    journal1.planStep(task.taskId, {
      stepId: 'step-a-textedit',
      intent: 'computer-input',
      tool: 'pet_cua_type',
      target: { surface: 'desktop', bundleId: 'com.apple.TextEdit' },
      payloadDigest: 'e'.repeat(64),
    }, 1_001);
    journal1.planStep(task.taskId, {
      stepId: 'step-b-finder-view',
      intent: 'switch Finder view mode to List (cmd+2)',
      tool: 'pet_cua_key',
      target: { surface: 'desktop', bundleId: 'com.apple.finder' },
      payloadDigest: 'f'.repeat(64),
    }, 1_002);
    expect(journal1.markDispatched(task.taskId, 'step-a-textedit', 'rcpt-a', 1, 1_003)).toBe(true);
    expect(journal1.recordReceipt(task.taskId, 'step-a-textedit', 1, {
      status: 'verified', externalCheckDigest: '8'.repeat(64), note: 'verified before restart',
    }, 1_004)).toEqual({ applied: true });

    // Process restart (NOT explicit cancel): task remains active and resumable
    const journal2 = new TaskContinuationJournal(file);
    journal2.recoverAfterRestart(2_000);
    const resumable = journal2.findResumableTask();
    expect(resumable?.taskId).toBe('task-restart-continue-1');
    expect(resumable?.status).toBe('active');
    expect(resumable?.generation).toBe(1);

    const decision = await journal2.planResume(resumable!.taskId, async () => ({ state: 'unknown' }), 2_001);
    expect(decision?.skippedStepIds).toEqual(['step-a-textedit']);
    expect(decision?.nextStep?.stepId).toBe('step-b-finder-view');

    // Executing planned Step B updates it in-place and completes the task
    const matched = journal2.findPlannedStep(task.taskId, 'pet_cua_key', 'com.apple.finder');
    expect(matched?.stepId).toBe('step-b-finder-view');
    expect(journal2.markDispatched(task.taskId, matched!.stepId, 'rcpt-b', 1, 2_002)).toBe(true);
    expect(journal2.recordReceipt(task.taskId, matched!.stepId, 1, {
      status: 'verified', externalCheckDigest: '7'.repeat(64), note: 'Finder view verified',
    }, 2_003)).toEqual({ applied: true });
    expect(journal2.getTask(task.taskId)?.status).toBe('completed');
    expect(journal2.findResumableTask()).toBeNull();
  });
});
