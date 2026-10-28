import { describe, expect, it } from 'vitest';
import { ActionGate } from '../core/action-gate.ts';

const gate = (policy: { writes: boolean; input?: boolean }) => new ActionGate({
  platformWrites: () => policy.writes,
  computerInput: () => policy.input ?? true,
});

describe('action gate', () => {
  it('lets reading through whatever the settings say', () => {
    expect(gate({ writes: false, input: false }).check({ surface: 'browser', tool: 'browser_read', impact: 'read' })).toEqual({ allow: true });
    expect(gate({ writes: false, input: false }).check({ surface: 'desktop', tool: 'pet_cua_screenshot', impact: 'read' })).toEqual({ allow: true });
  });

  it('refuses a site write while the browser is read-only, and allows it once the setting is on', () => {
    const policy = { writes: false };
    const g = gate(policy);
    expect(g.check({ surface: 'browser', tool: 'browser_click', impact: 'platform-write', target: '点赞 12' }))
      .toMatchObject({ allow: false, refusal: 'read-only' });
    policy.writes = true;
    expect(g.check({ surface: 'browser', tool: 'browser_click', impact: 'platform-write' })).toEqual({ allow: true });
  });

  it('reads the live settings at each check instead of caching the first answer', () => {
    let writes = false;
    const g = new ActionGate({ platformWrites: () => writes, computerInput: () => true });
    expect(g.check({ surface: 'browser', tool: 'browser_share', impact: 'platform-write' }).allow).toBe(false);
    writes = true;
    expect(g.check({ surface: 'browser', tool: 'browser_share', impact: 'platform-write' }).allow).toBe(true);
  });

  it('refuses payment, login and private messages even with everything switched on', () => {
    const g = gate({ writes: true, input: true });
    for (const impact of ['sensitive'] as const) {
      const verdict = g.check({ surface: 'browser', tool: 'browser_click', impact, target: '立即购买' });
      expect(verdict).toMatchObject({ allow: false, refusal: 'sensitive' });
    }
    expect(g.check({ surface: 'desktop', tool: 'pet_cua_click', impact: 'sensitive' })).toMatchObject({ allow: false, refusal: 'sensitive' });
  });

  it('refuses computer input while the person has it off', () => {
    const verdict = gate({ writes: true, input: false }).check({ surface: 'desktop', tool: 'pet_cua_type', impact: 'computer-input' });
    expect(verdict).toMatchObject({ allow: false, refusal: 'not-armed' });
    expect(verdict.allow === false && verdict.detail).toContain('pet_cua_type');
  });

  it('refuses a surface and impact pair it does not know', () => {
    expect(gate({ writes: true }).check({ surface: 'desktop', tool: 'some_tool', impact: 'platform-write' }))
      .toMatchObject({ allow: false, refusal: 'not-armed' });
  });
});
