import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { createTerminalFigure } from '../packages/cortico-world-desktop-pet/web/opencode/opencode.js';

describe('opencode figure pack', () => {
  it('draws its five guest states', () => {
    const dom = new JSDOM('<!doctype html><svg><g id="root"></g></svg>');
    const petG = dom.window.document.getElementById('root');
    const state = { guest: 'idle' };
    const figure = createTerminalFigure(state);
    const draw = (guest, gesture = null) => {
      state.guest = guest;
      figure.draw(petG, {}, { t: 1, blink: 0, facing: 1, gesture });
      return petG.querySelector('.op').getAttribute('data-guest');
    };

    expect(draw('idle')).toBe('idle');
    expect(petG.querySelector('.op-shell')).toBeTruthy();
    expect(petG.querySelector('.op-screen')).toBeTruthy();

    const states = [
      ['work', '.op-keyboard'],
      ['wait', '.op-wait'],
      ['done', '.op-check'],
      ['oops', '.op-error'],
    ];
    for (const [guest, selector] of states) {
      expect(draw(guest), guest).toBe(guest);
      expect(petG.querySelector(selector), guest).toBeTruthy();
    }

    expect(draw('idle', { kind: 'work' })).toBe('work');
  });
});
