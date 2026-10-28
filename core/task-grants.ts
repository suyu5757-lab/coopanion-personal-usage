/** Short lived user grants and one-use tickets for actions bound to a verified target. */
import { createHash, randomUUID } from 'node:crypto';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ActionTargetEvidence = DesktopTargetEvidence | BrowserTargetEvidence;

export interface DesktopTargetEvidence {
  surface: 'desktop';
  instanceId: string;
  bundleId: string;
  executablePath: string;
  pid: number;
  ownerPid: number;
  processStart: string;
  windowId: number;
  bounds: Rect;
  display: string | null;
  space: string | null;
  snapshotId: string;
  captureId: string;
  element?: { role: string; label: string; token: string };
  route: 'background-ax' | 'background-window-pixel';
  source: 'cua-driver';
}

export interface BrowserTargetEvidence {
  surface: 'browser';
  instanceId: string;
  origin: string;
  url: string;
  accountRef: string;
  snapshotId: string;
  formId: string;
  control: string;
}

export interface TaskGrantRequest {
  taskId: string;
  taskText: string;
  target: ActionTargetEvidence;
  actions: string[];
  files?: Array<{ path: string; digest: string; bytes: number; mime: string }>;
  expiresInMs: number;
  maxSteps: number;
}

export interface TaskGrant {
  id: string;
  taskId: string;
  taskText: string;
  surface: ActionTargetEvidence['surface'];
  targetDigest: string;
  actions: readonly string[];
  files: readonly { path: string; digest: string; bytes: number; mime: string }[];
  permissionGeneration: string;
  approvedAt: number;
  expiresAt: number;
  maxSteps: number;
  stepsUsed: number;
  digest: string;
  revoked: boolean;
}

export interface StepRequest {
  action: string;
  target: ActionTargetEvidence;
  expectedChange: string;
  files?: Array<{ path: string; digest: string; bytes: number; mime: string }>;
}

export interface StepTicket {
  id: string;
  grantId: string;
  taskId: string;
  action: string;
  targetDigest: string;
  snapshotDigest: string;
  expectedChangeDigest: string;
  permissionGeneration: string;
  issuedAt: number;
  expiresAt: number;
}

interface TicketRecord {
  ticket: StepTicket;
  request: StepRequest;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = (values: readonly string[]) => [...values].sort();
const safeRelativePath = (path: string) => !!path.trim() && !path.startsWith('/') && !path.startsWith('\\')
  && !path.includes('\0') && !path.split(/[\\/]/).some((part) => part === '..' || part === '');
const normalizeFiles = (files: readonly { path: string; digest: string; bytes: number; mime: string }[] | undefined) =>
  [...(files ?? [])].map(({ path, digest, bytes, mime }) => ({ path, digest, bytes, mime }));
const targetIdentity = (target: ActionTargetEvidence): unknown => target.surface === 'desktop'
  ? [target.surface, target.instanceId, target.bundleId, target.executablePath, target.pid, target.ownerPid, target.processStart, target.windowId]
  : [target.surface, target.instanceId, target.origin, target.url, target.accountRef, target.formId, target.control];
const targetSnapshot = (target: ActionTargetEvidence): unknown => target.surface === 'desktop'
  ? [target.snapshotId, target.captureId, target.bounds, target.display, target.space, target.element?.role ?? '', target.element?.label ?? '', target.element?.token ?? '', target.route]
  : [target.snapshotId, target.url, target.accountRef, target.formId, target.control];

function validTarget(target: ActionTargetEvidence): boolean {
  if (target.surface === 'desktop') {
    return !!target.instanceId && !!target.bundleId && !!target.executablePath && target.pid > 0
      && target.ownerPid === target.pid && !!target.processStart && target.windowId > 0
      && [target.bounds.x, target.bounds.y, target.bounds.width, target.bounds.height].every(Number.isFinite)
      && target.bounds.width > 0 && target.bounds.height > 0 && !!target.snapshotId && !!target.captureId
      && (target.element === undefined || (!!target.element.role && !!target.element.label && !!target.element.token
        && target.element.token.startsWith(`${target.snapshotId}:`)));
  }
  return !!target.instanceId && !!target.origin && !!target.url && !!target.accountRef
    && !!target.snapshotId && !!target.formId && !!target.control;
}

/** Core owns this registry; callers supply the confirmation callback bound to the app's own UI. */
export class TaskGrantRegistry {
  private readonly grants = new Map<string, TaskGrant>();
  private readonly tickets = new Map<string, TicketRecord>();

  constructor(private generation: string) {}

  /** Any relevant preference change invalidates pending grants and tickets. */
  synchronizePermissionGeneration(next: string): void {
    if (next === this.generation) return;
    this.generation = next;
    this.grants.clear();
    this.tickets.clear();
  }

  async requestGrant(
    request: TaskGrantRequest,
    confirmInCoreUi: () => Promise<boolean>,
    now = Date.now(),
    stillAllowed: () => boolean = () => true,
  ): Promise<TaskGrant | null> {
    const actions = sorted(request.actions);
    const files = normalizeFiles(request.files);
    if (!request.taskId || !request.taskText.trim() || request.taskText.length > 4000 || !validTarget(request.target)
      || actions.length === 0 || actions.length > 16 || files.some((file) => !safeRelativePath(file.path)
        || !/^[a-f0-9]{64}$/.test(file.digest) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !file.mime.trim())
      || !Number.isSafeInteger(request.expiresInMs) || request.expiresInMs < 1_000 || request.expiresInMs > 60 * 60_000
      || !Number.isSafeInteger(request.maxSteps) || request.maxSteps < 1 || request.maxSteps > 200) {
      throw new Error('task grant request is incomplete or outside its limits');
    }
    if (!await confirmInCoreUi()) return null;
    if (!stillAllowed()) return null;
    const targetDigest = hash(targetIdentity(request.target));
    const grant: TaskGrant = {
      id: randomUUID(),
      taskId: request.taskId,
      taskText: request.taskText,
      surface: request.target.surface,
      targetDigest,
      actions,
      files,
      permissionGeneration: this.generation,
      approvedAt: now,
      expiresAt: now + request.expiresInMs,
      maxSteps: request.maxSteps,
      stepsUsed: 0,
      digest: hash([request.taskId, request.taskText, targetDigest, actions, files, this.generation, now, request.expiresInMs, request.maxSteps]),
      revoked: false,
    };
    this.grants.set(grant.id, grant);
    return structuredClone(grant);
  }

  issueStepTicket(grantId: string, request: StepRequest, now = Date.now()): StepTicket | null {
    const grant = this.grants.get(grantId);
    if (!grant || !this.usable(grant, request, now)) return null;
    const ticket: StepTicket = {
      id: randomUUID(),
      grantId,
      taskId: grant.taskId,
      action: request.action,
      targetDigest: grant.targetDigest,
      snapshotDigest: hash(targetSnapshot(request.target)),
      expectedChangeDigest: hash(request.expectedChange),
      permissionGeneration: this.generation,
      issuedAt: now,
      expiresAt: Math.min(grant.expiresAt, now + 5_000),
    };
    this.tickets.set(ticket.id, { ticket, request: structuredClone(request) });
    return structuredClone(ticket);
  }

  /** Consumes the ticket before returning, including when the fresh evidence no longer matches. */
  consumeStepTicket(ticketId: string, current: StepRequest, now = Date.now()): boolean {
    const record = this.tickets.get(ticketId);
    this.tickets.delete(ticketId);
    if (!record) return false;
    const grant = this.grants.get(record.ticket.grantId);
    if (!grant || !this.usable(grant, current, now) || record.ticket.permissionGeneration !== this.generation
      || record.ticket.taskId !== grant.taskId || record.ticket.action !== current.action
      || record.ticket.targetDigest !== hash(targetIdentity(current.target))
      || record.ticket.snapshotDigest !== hash(targetSnapshot(current.target))
      || record.ticket.expectedChangeDigest !== hash(current.expectedChange)
      || hash(normalizeFiles(record.request.files)) !== hash(normalizeFiles(current.files))) return false;
    grant.stepsUsed++;
    if (grant.stepsUsed >= grant.maxSteps) this.grants.delete(grant.id);
    return true;
  }

  revokeTask(taskId: string): void {
    for (const [id, grant] of this.grants) if (grant.taskId === taskId) this.grants.delete(id);
    for (const [id, record] of this.tickets) if (record.ticket.taskId === taskId) this.tickets.delete(id);
  }

  revokeAll(): void {
    this.grants.clear();
    this.tickets.clear();
  }

  private usable(grant: TaskGrant, request: StepRequest, now: number): boolean {
    const files = normalizeFiles(request.files);
    return !grant.revoked && grant.permissionGeneration === this.generation && now <= grant.expiresAt
      && grant.stepsUsed < grant.maxSteps && grant.surface === request.target.surface
      && grant.actions.includes(request.action) && validTarget(request.target)
      && grant.targetDigest === hash(targetIdentity(request.target))
      && hash(files) === hash(grant.files);
  }
}
