import { describe, expect, it } from 'vitest';
import type { ToolCallContext, ToolOutcome } from 'cortico/core/types.ts';
import { ActionGate } from '../core/action-gate.ts';
import { Cua } from '../packages/cortico-world-desktop-pet/src/cua/cua.ts';
import { CUA_DEFAULTS } from '../packages/cortico-world-desktop-pet/src/cua/config.ts';
import type { CuaDriverLike } from '../packages/cortico-world-desktop-pet/src/cua/driver.ts';
import { cuaText } from '../packages/cortico-world-desktop-pet/src/cua/i18n/index.ts';

const attempts: Array<[string, Record<string, unknown>]> = [
  ['pet_cua_click', { x: 10, y: 10 }],
  ['pet_cua_click', { elementToken: 'snapshot:publish' }],
  ['pet_cua_drag', { fromX: 10, fromY: 10, toX: 20, toY: 20 }],
  ['pet_cua_type', { text: 'submit' }],
  ['pet_cua_key', { keys: 'Tab Enter' }],
  ['pet_cua_key', { keys: 'Enter' }],
  ['pet_cua_key', { keys: 'Space' }],
  ['pet_cua_key', { keys: 'Cmd+Enter' }],
  ['pet_cua_focus', { window: 'another window' }],
  ['pet_cua_move', { x: 10, y: 10 }],
  ['pet_cua_scroll', { down: 1 }],
];

describe('CUA input through the shared action gate', () => {
  it.each(attempts)('refuses %s before approval or driver dispatch', async (tool, args) => {
    const gate = new ActionGate({ platformWrites: () => true, imageGeneration: () => false, imageSaving: () => false, mediaUpload: () => false, computerInput: () => true });
    let dispatched = 0;
    let questions = 0;
    const driver = new Proxy({} as CuaDriverLike, {
      get() { dispatched++; throw new Error('unexpected desktop dispatch'); },
    });
    const cua = new Cua({
      cfg: () => ({ ...CUA_DEFAULTS, enabled: true, control: true, permission: 'never-ask' }),
      driver: () => driver,
      modelLanguage: () => 'en',
      askPermission: async () => { questions++; return 'yes'; },
      allowInput: (name) => gate.check({ surface: 'desktop', tool: name, impact: 'computer-input' }).allow,
    });
    const handler = cua.tools().find((decl) => decl.name === tool)!.handler;
    const outcome = await handler(args, {} as ToolCallContext) as ToolOutcome;
    expect(outcome.failed).toBe(true);
    expect(outcome.text).toContain('CUA input is unavailable');
    expect(dispatched).toBe(0);
    expect(questions).toBe(0);
    expect(cua.lamp('en').hint).toContain(cuaText('en').console.viewOnly);
    await cua.stop();
  });

  it('keeps browser and desktop reads available while desktop input is closed', () => {
    const gate = new ActionGate({ platformWrites: () => true, imageGeneration: () => false, imageSaving: () => false, mediaUpload: () => false, computerInput: () => true });
    expect(gate.check({ surface: 'desktop', tool: 'pet_cua_screenshot', impact: 'read' }).allow).toBe(true);
    expect(gate.check({ surface: 'browser', tool: 'browser_read', impact: 'read' }).allow).toBe(true);
    expect(gate.check({ surface: 'browser', tool: 'browser_type', impact: 'platform-write' }).allow).toBe(true);
    expect(gate.check({ surface: 'desktop', tool: 'pet_cua_click', impact: 'computer-input' }))
      .toMatchObject({ allow: false, refusal: 'unverified-target' });
  });
});
