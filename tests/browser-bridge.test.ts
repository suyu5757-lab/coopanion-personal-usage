import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserBridge } from '../core/browser/bridge.ts';

let sent: object[] = [];
let oldSend: PropertyDescriptor | undefined;
let bridge: BrowserBridge | null = null;

beforeEach(() => {
  sent = [];
  oldSend = Object.getOwnPropertyDescriptor(process, 'send');
  Object.defineProperty(process, 'send', {
    configurable: true,
    writable: true,
    value: (message: object) => { sent.push(message); return true; },
  });
});

afterEach(() => {
  bridge?.close();
  bridge = null;
  if (oldSend) Object.defineProperty(process, 'send', oldSend);
  else Reflect.deleteProperty(process, 'send');
});

describe('BrowserBridge cancellation', () => {
  it('relays an interrupted media download to the Electron host', async () => {
    bridge = new BrowserBridge();
    const controller = new AbortController();
    const call = bridge.call('download-media', { token: 'opaque' }, controller.signal);
    controller.abort();

    await expect(call).rejects.toThrow('interrupted');
    expect(sent).toEqual([
      expect.objectContaining({ type: 'companion:browser', op: 'download-media' }),
      expect.objectContaining({ type: 'companion:browser-cancel' }),
    ]);
  });

  it('cancels remaining host operations when the Core bridge closes', async () => {
    bridge = new BrowserBridge();
    const call = bridge.call('download-media', { token: 'opaque' });
    bridge.close();

    await expect(call).rejects.toThrow('browser bridge closed');
    expect(sent.at(-1)).toMatchObject({ type: 'companion:browser-cancel' });
  });
});
