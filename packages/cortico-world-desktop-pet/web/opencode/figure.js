/**
 * The opencode pack's entry: the terminal draws itself on the kit (web/kit/body.js), which handles
 * walking, blinking, touching and the group transform. The page sets `guest` through `set` to show
 * boot, work, wait, done or oops; when it is the pet's own figure the kit's words do the same.
 */
import { createTerminalFigure, TERMINAL_CSS, TERMINAL_WORDS } from './opencode.js';

export function createOpencodeBody(base, { kit, host }) {
  const state = { guest: 'idle' };
  const figure = createTerminalFigure(state);
  const body = kit.createBody(host, { figure, css: TERMINAL_CSS, words: TERMINAL_WORDS });
  const set = body.set;
  body.set = (s) => {
    if (!s || typeof s !== 'object') return;
    if (typeof s.guest === 'string') state.guest = s.guest;
    const { guest: _guest, ...rest } = s;
    if (Object.keys(rest).length) set(rest);
  };
  return body;
}
