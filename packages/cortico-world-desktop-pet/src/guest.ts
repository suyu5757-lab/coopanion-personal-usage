/** The guest avatar beside the pet: what a World may ask the page to show, without knowing the page. */
export type GuestPhase = 'boot' | 'work' | 'wait' | 'done' | 'oops';

export interface GuestOrder {
  show: boolean;
  state?: GuestPhase;
  taskId?: string;
}
