import { TaskGrantRegistry, type StepRequest, type StepTicket, type TaskGrant, type TaskGrantRequest } from './task-grants.ts';

/**
 * The one place that decides whether a tool may change something outside Coo's own state.
 *
 * Two surfaces reach the outside world: her own browser window and the person's screen. Each asks
 * this gate before acting, so a new tool cannot grow its own permission rule and the two surfaces
 * cannot be swapped to get around one. What the page says, what a button is labelled and what the
 * model claims are evidence a World passes in; they never decide policy here.
 *
 * The gate answers what the live configuration allows. Reading is free; a site write needs
 * `companion.selfTime.actions`; desktop input stays closed without trusted window origins. Spending
 * money, accessing files, logging in, changing the account or opening a private conversation is
 * refused whatever is switched on. Exact-action approval remains a World-level check.
 */
export type Surface = 'browser' | 'desktop';
export type Impact = 'read' | 'platform-write' | 'image-generation' | 'image-saving' | 'media-upload' | 'computer-input' | 'sensitive';
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
  /** `worlds.desktop-pet.cua.control`: the mouse and keyboard on the person's screen. */
  computerInput: () => boolean;
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
    if (request.surface === 'desktop' && request.impact === 'computer-input') {
      if (!this.policy.computerInput()) {
        return { allow: false, refusal: 'not-armed', detail: `${request.tool}${describeTarget(request)} uses the mouse or keyboard while computer input is off` };
      }
      // CUA has no trusted window-origin contract. Its inputs could bypass Browser's manual publish boundary.
      return { allow: false, refusal: 'unverified-target', detail: `${request.tool} is unavailable until desktop targets can be verified as outside browser windows; use Browser tools and leave final publication to the person` };
    }
    return { allow: false, refusal: 'not-armed', detail: `${request.tool} is not a ${request.surface}/${request.impact} action this gate allows` };
  }

  /** Issues a short grant only after Core's own approval UI confirms the proposed task. */
  async requestTaskGrant(request: TaskGrantRequest, confirmInCoreUi: () => Promise<boolean>, now = Date.now()): Promise<TaskGrant | null> {
    this.synchronizeGeneration();
    if (request.actions.some((action) => !this.capabilityAllows(request.target.surface, action as Impact))) return null;
    const generation = this.permissionGeneration();
    return this.grants.requestGrant(request, confirmInCoreUi, now, () => {
      this.synchronizeGeneration();
      return generation === this.permissionGeneration()
        && request.actions.every((action) => this.capabilityAllows(request.target.surface, action as Impact));
    });
  }

  /** Mints a one-use ticket from fresh evidence for one action inside a task grant. */
  issueStepTicket(grantId: string, request: StepRequest, now = Date.now()): StepTicket | null {
    this.synchronizeGeneration();
    if (!this.capabilityAllows(request.target.surface, request.action as Impact)) return null;
    return this.grants.issueStepTicket(grantId, request, now);
  }

  /** Consumes a ticket before dispatch; the same ticket can never authorize a second step. */
  consumeStepTicket(ticketId: string, request: StepRequest, now = Date.now()): boolean {
    this.synchronizeGeneration();
    if (!this.capabilityAllows(request.target.surface, request.action as Impact)) return false;
    return this.grants.consumeStepTicket(ticketId, request, now);
  }

  revokeTask(taskId: string): void {
    this.synchronizeGeneration();
    this.grants.revokeTask(taskId);
  }

  revokeAll(): void {
    this.grants.revokeAll();
  }

  private capabilityAllows(surface: Surface, impact: Impact): boolean {
    if (surface === 'browser') {
      if (impact === 'platform-write') return this.policy.platformWrites();
      if (impact === 'image-generation') return this.policy.imageGeneration();
      if (impact === 'image-saving') return this.policy.imageSaving();
      if (impact === 'media-upload') return this.policy.mediaUpload();
      return false;
    }
    return impact === 'computer-input' && this.policy.computerInput();
  }

  private permissionGeneration(): string {
    return JSON.stringify([
      this.policy.platformWrites(), this.policy.imageGeneration(), this.policy.imageSaving(),
      this.policy.mediaUpload(), this.policy.computerInput(),
    ]);
  }

  private synchronizeGeneration(): void {
    this.grants.synchronizePermissionGeneration(this.permissionGeneration());
  }
}
