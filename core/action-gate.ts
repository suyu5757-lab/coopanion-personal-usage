import { TaskGrantRegistry, type ActionRisk, type ActionTargetEvidence, type DesktopTargetEvidence, type FileSystemTargetEvidence, type StepRequest, type StepTicket, type TaskGrant, type TaskGrantRequest } from './task-grants.ts';

/**
 * The one place that decides whether a tool may change something outside Coo's own state.
 *
 * Browser, desktop and workspace actions use this gate, so a tool cannot add a separate permission
 * rule for an existing surface. What a page says, what a button is labelled and what the model
 * claims are evidence a World passes in; they never decide policy here.
 *
 * The gate answers what the live configuration allows. Reading is free; a site write needs
 * `companion.selfTime.actions`; desktop input stays closed without trusted window origins. Spending
 * money, accessing files, logging in, changing the account or opening a private conversation is
 * refused whatever is switched on. Exact-action approval remains a World-level check.
 */
export type Surface = 'browser' | 'desktop' | 'filesystem';
export type Impact = 'read' | 'platform-write' | 'image-generation' | 'image-saving' | 'media-upload' | 'media-download' | 'computer-input' | 'file-write' | 'command-execution' | 'platform-api' | 'sensitive';
export type Refusal = 'read-only' | 'sensitive' | 'not-armed' | 'unverified-target';

export interface ActionRequest {
  surface: Surface;
  /** The tool's name, for the refusal and the log. */
  tool: string;
  impact: Impact;
  /** What the action is aimed at, in words. Evidence, not policy. */
  target?: string;
}

export type Verdict =
  | { allow: true }
  | { allow: false; refusal: Refusal; detail: string };

export interface DesktopStepAuthorization {
  grantDigest: string;
  approvedAt: number;
  expiresAt: number;
  /** Consumes one ticket only when the dispatch evidence still matches the approved snapshot. */
  consume(target: DesktopTargetEvidence | null, expectedChange: string): boolean;
  /** Revokes a grant when the caller cannot dispatch the approved step. */
  revoke(): void;
}

export interface DesktopStepGrantRequest {
  taskId: string;
  taskText: string;
  expectedChange: string;
  risk: ActionRisk;
  target: DesktopTargetEvidence;
  expiresInMs: number;
  maxSteps: 1;
}

export interface FileSystemStepGrantRequest {
  taskId: string;
  taskText: string;
  expectedChange: string;
  risk: ActionRisk;
  target: FileSystemTargetEvidence;
  action: 'file-write' | 'command-execution';
  files: Array<{ path: string; digest: string; bytes: number; mime: string }>;
  expiresInMs: number;
  maxSteps: 1;
}

export interface FileSystemStepAuthorization {
  grantDigest: string;
  approvedAt: number;
  expiresAt: number;
  consume(
    target: FileSystemTargetEvidence,
    expectedChange: string,
    files: readonly { path: string; digest: string; bytes: number; mime: string }[],
  ): boolean;
  revoke(): void;
}

const desktopEvidenceKey = (target: DesktopTargetEvidence): string => JSON.stringify([
  target.instanceId, target.bundleId, target.executablePath, target.pid, target.ownerPid,
  target.processStart, target.windowId,
  [target.bounds.x, target.bounds.y, target.bounds.width, target.bounds.height],
  target.display, target.space, target.snapshotId, target.captureId,
  target.element ? [target.element.role, target.element.label, target.element.token] : null,
  target.route, target.source,
]);
const fileSystemEvidenceKey = (target: FileSystemTargetEvidence): string => JSON.stringify([
  target.instanceId, target.workspaceRoot, target.path, target.operation, target.snapshotId, target.source,
]);

/** What the person's settings currently allow; read at each check, never cached. */
export interface GatePolicy {
  /** `companion.selfTime.actions`: likes, favorites, follows, comments, danmaku and sharing. */
  platformWrites: () => boolean;
  /** `companion.selfTime.imageGeneration`. */
  imageGeneration: () => boolean;
  /** `companion.selfTime.imageSaving`. */
  imageSaving: () => boolean;
  /** `companion.selfTime.mediaUpload`. */
  mediaUpload: () => boolean;
  /** `companion.selfTime.mediaDownload`; absent policy defaults to off. */
  mediaDownload?: () => boolean;
  /** `worlds.desktop-pet.cua.control`: the mouse and keyboard on the person's screen. */
  computerInput: () => boolean;
  /** The desktop World owns the supported native app and input-route rules. */
  desktopTargetAllowed: (target: DesktopTargetEvidence) => boolean;
  /** File and command actions stay inside a live, explicitly allowed workspace. */
  fileSystemActionAllowed?: (target: FileSystemTargetEvidence, action: 'file-write' | 'command-execution') => boolean;
  /** Changes to allowed roots invalidate pending grants. */
  fileSystemPermissionGeneration?: () => string;
}

const describeTarget = (request: ActionRequest): string => request.target ? `「${request.target}」` : '';

export class ActionGate {
  private readonly grants: TaskGrantRegistry;

  constructor(private readonly policy: GatePolicy) {
    this.grants = new TaskGrantRegistry(this.permissionGeneration());
  }

  check(request: ActionRequest): Verdict {
    if (request.impact === 'read') return { allow: true };
    if (request.impact === 'sensitive') {
      return { allow: false, refusal: 'sensitive', detail: `${request.tool}${describeTarget(request)} touches payment, login, the account or a private message` };
    }
    if (request.surface === 'browser' && request.impact === 'platform-write') {
      return this.policy.platformWrites()
        ? { allow: true }
        : { allow: false, refusal: 'read-only', detail: `${request.tool}${describeTarget(request)} writes to the site while the browser is read-only` };
    }
    if (request.surface === 'browser' && request.impact === 'image-generation') {
      return this.policy.imageGeneration()
        ? { allow: true }
        : { allow: false, refusal: 'not-armed', detail: `${request.tool}${describeTarget(request)} submits an image prompt while image generation is off` };
    }
    if (request.surface === 'browser' && request.impact === 'image-saving') {
      return this.policy.imageSaving()
        ? { allow: true }
        : { allow: false, refusal: 'not-armed', detail: `${request.tool}${describeTarget(request)} saves an image while image saving is off` };
    }
    if (request.surface === 'browser' && request.impact === 'media-upload') {
      return this.policy.mediaUpload()
        ? { allow: true }
        : { allow: false, refusal: 'not-armed', detail: `${request.tool}${describeTarget(request)} selects media while uploads are off` };
    }
    if (request.surface === 'browser' && request.impact === 'media-download') {
      return (this.policy.mediaDownload?.() ?? false)
        ? { allow: true }
        : { allow: false, refusal: 'not-armed', detail: `${request.tool}${describeTarget(request)} downloads media while media downloads are off` };
    }
    if (request.surface === 'desktop' && request.impact === 'computer-input') {
      if (!this.policy.computerInput()) {
        return { allow: false, refusal: 'not-armed', detail: `${request.tool}${describeTarget(request)} uses the mouse or keyboard while computer input is off` };
      }
      // A generic CUA request carries no typed window evidence; desktop input must use a task grant.
      return { allow: false, refusal: 'unverified-target', detail: `${request.tool} needs a Core task grant bound to an allowed native window; use Browser tools for browser work and leave final publication to the person` };
    }
    if (request.surface === 'filesystem' && (request.impact === 'file-write' || request.impact === 'command-execution')) {
      return { allow: false, refusal: 'unverified-target', detail: `${request.tool} needs a Core task grant bound to an allowed workspace and exact operation` };
    }
    return { allow: false, refusal: 'not-armed', detail: `${request.tool} is not a ${request.surface}/${request.impact} action this gate allows` };
  }

  /** Issues a short grant only after Core's own approval UI confirms the proposed task. */
  async requestTaskGrant(request: TaskGrantRequest, confirmInCoreUi: () => Promise<boolean>, now = Date.now()): Promise<TaskGrant | null> {
    this.synchronizeGeneration();
    if (request.actions.some((action) => !this.capabilityAllows(request.target.surface, action as Impact, request.target))) return null;
    const generation = this.permissionGeneration();
    return this.grants.requestGrant(request, confirmInCoreUi, now, () => {
      this.synchronizeGeneration();
      return generation === this.permissionGeneration()
        && request.actions.every((action) => this.capabilityAllows(request.target.surface, action as Impact, request.target));
    });
  }

  /** Creates a one-step desktop grant and delays ticket consumption until the dispatch boundary. */
  async requestDesktopStep(
    request: DesktopStepGrantRequest,
    confirmInCoreUi: () => Promise<boolean>,
  ): Promise<DesktopStepAuthorization | null> {
    const approvedEvidence = desktopEvidenceKey(request.target);
    const grant = await this.requestTaskGrant({
      taskId: request.taskId,
      taskText: request.taskText,
      risk: request.risk,
      target: request.target,
      actions: ['computer-input'],
      expiresInMs: request.expiresInMs,
      maxSteps: request.maxSteps,
    }, confirmInCoreUi);
    if (!grant) return null;

    let finished = false;
    const revoke = () => {
      if (finished) return;
      finished = true;
      this.revokeTask(request.taskId);
    };
    return {
      grantDigest: grant.digest,
      approvedAt: grant.approvedAt,
      expiresAt: grant.expiresAt,
      consume: (target, expectedChange) => {
        if (finished) return false;
        finished = true;
        if (!target || expectedChange !== request.expectedChange || desktopEvidenceKey(target) !== approvedEvidence) {
          this.revokeTask(request.taskId);
          return false;
        }
        const step: StepRequest = { action: 'computer-input', target, expectedChange };
        const ticket = this.issueStepTicket(grant.id, step);
        const consumed = !!ticket && this.consumeStepTicket(ticket.id, step);
        this.revokeTask(request.taskId);
        return consumed;
      },
      revoke,
    };
  }

  /** Creates a one-step grant for an operation inside an allowed workspace. */
  async requestFileSystemStep(
    request: FileSystemStepGrantRequest,
    confirmInCoreUi: () => Promise<boolean>,
  ): Promise<FileSystemStepAuthorization | null> {
    const approvedEvidence = fileSystemEvidenceKey(request.target);
    const grant = await this.requestTaskGrant({
      taskId: request.taskId,
      taskText: request.taskText,
      risk: request.risk,
      target: request.target,
      actions: [request.action],
      files: request.files,
      expiresInMs: request.expiresInMs,
      maxSteps: request.maxSteps,
    }, confirmInCoreUi);
    if (!grant) return null;

    let finished = false;
    const revoke = () => {
      if (finished) return;
      finished = true;
      this.revokeTask(request.taskId);
    };
    return {
      grantDigest: grant.digest,
      approvedAt: grant.approvedAt,
      expiresAt: grant.expiresAt,
      consume: (target, expectedChange, files) => {
        if (finished) return false;
        finished = true;
        if (expectedChange !== request.expectedChange || fileSystemEvidenceKey(target) !== approvedEvidence) {
          this.revokeTask(request.taskId);
          return false;
        }
        const step: StepRequest = { action: request.action, target, expectedChange, files: [...files] };
        const ticket = this.issueStepTicket(grant.id, step);
        const consumed = !!ticket && this.consumeStepTicket(ticket.id, step);
        this.revokeTask(request.taskId);
        return consumed;
      },
      revoke,
    };
  }

  /** Mints a one-use ticket from fresh evidence for one action inside a task grant. */
  issueStepTicket(grantId: string, request: StepRequest, now = Date.now()): StepTicket | null {
    this.synchronizeGeneration();
    if (!this.capabilityAllows(request.target.surface, request.action as Impact, request.target)) return null;
    return this.grants.issueStepTicket(grantId, request, now);
  }

  /** Consumes a ticket before dispatch; the same ticket can never authorize a second step. */
  consumeStepTicket(ticketId: string, request: StepRequest, now = Date.now()): boolean {
    this.synchronizeGeneration();
    if (!this.capabilityAllows(request.target.surface, request.action as Impact, request.target)) return false;
    return this.grants.consumeStepTicket(ticketId, request, now);
  }

  revokeTask(taskId: string): void {
    this.synchronizeGeneration();
    this.grants.revokeTask(taskId);
  }

  revokeAll(): void {
    this.grants.revokeAll();
  }

  private capabilityAllows(surface: Surface, impact: Impact, target?: ActionTargetEvidence): boolean {
    if (surface === 'browser') {
      if (impact === 'platform-write') return this.policy.platformWrites();
      if (impact === 'image-generation') return this.policy.imageGeneration();
      if (impact === 'image-saving') return this.policy.imageSaving();
      if (impact === 'media-upload') return this.policy.mediaUpload();
      if (impact === 'media-download') return this.policy.mediaDownload?.() ?? false;
      return false;
    }
    if (surface === 'desktop') {
      return impact === 'computer-input' && this.policy.computerInput()
        && target?.surface === 'desktop' && this.policy.desktopTargetAllowed(target);
    }
    return (impact === 'file-write' || impact === 'command-execution')
      && target?.surface === 'filesystem'
      && this.policy.fileSystemActionAllowed?.(target, impact) === true;
  }

  private permissionGeneration(): string {
    return JSON.stringify([
      this.policy.platformWrites(), this.policy.imageGeneration(), this.policy.imageSaving(),
      this.policy.mediaUpload(), this.policy.computerInput(), this.policy.fileSystemPermissionGeneration?.() ?? '',
      this.policy.mediaDownload?.() ?? false,
    ]);
  }

  private synchronizeGeneration(): void {
    this.grants.synchronizePermissionGeneration(this.permissionGeneration());
  }
}
