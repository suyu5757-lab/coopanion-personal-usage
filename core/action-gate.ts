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
export type Impact = 'read' | 'platform-write' | 'computer-input' | 'sensitive';
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
  /** `worlds.desktop-pet.cua.control`: the mouse and keyboard on the person's screen. */
  computerInput: () => boolean;
}

const describeTarget = (request: ActionRequest): string => request.target ? `「${request.target}」` : '';

export class ActionGate {
  constructor(private readonly policy: GatePolicy) {}

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
    if (request.surface === 'desktop' && request.impact === 'computer-input') {
      if (!this.policy.computerInput()) {
        return { allow: false, refusal: 'not-armed', detail: `${request.tool}${describeTarget(request)} uses the mouse or keyboard while computer input is off` };
      }
      // CUA has no trusted window-origin contract. Its inputs could bypass Browser's manual publish boundary.
      return { allow: false, refusal: 'unverified-target', detail: `${request.tool} is unavailable until desktop targets can be verified as outside browser windows; use Browser tools and leave final publication to the person` };
    }
    return { allow: false, refusal: 'not-armed', detail: `${request.tool} is not a ${request.surface}/${request.impact} action this gate allows` };
  }
}
