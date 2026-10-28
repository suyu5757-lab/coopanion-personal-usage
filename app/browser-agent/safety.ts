/// <reference lib="dom" />
import { isFileChooserTarget } from './targets.ts';

/** Blocks file-picker events only while the host is dispatching an agent click or key. */
export function installFileChooserGuard(doc: Document): { setAgentAction(active: boolean): void } {
  let agentAction = false;
  const view = doc.defaultView;
  const isElement = (value: unknown): value is HTMLElement => !!view && value instanceof view.HTMLElement;
  const preventChooser = (event: Event): void => {
    if (!agentAction) return;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    if (!path.some((node) => isElement(node) && isFileChooserTarget(node))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  doc.addEventListener('click', preventChooser, true);

  const inputPrototype = view?.HTMLInputElement.prototype as (HTMLInputElement & { showPicker?: () => void }) | undefined;
  const showPicker = inputPrototype?.showPicker;
  if (inputPrototype && showPicker) {
    inputPrototype.showPicker = function(this: HTMLInputElement): void {
      if (agentAction && this.type.toLowerCase() === 'file') return;
      showPicker.call(this);
    };
  }

  return { setAgentAction: (active) => { agentAction = active; } };
}
