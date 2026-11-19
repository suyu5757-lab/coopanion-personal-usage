// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Lifecycle } from '../console/base/lifecycle.ts';
import { createConsoleUi } from '../console/base/ui/index.ts';
import { chatPage } from '../console/features/chat/index.ts';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let sockets;
let life;

class FakeSocket {
  readyState = 0;
  onopen = null;
  onclose = null;
  onerror = null;
  onmessage = null;
  constructor(url) {
    this.url = url;
    sockets.push(this);
    queueMicrotask(() => { this.readyState = 1; this.onopen?.({}); });
  }
  send() {}
  close() { this.readyState = 3; }
  frame(frame) { act(() => { this.onmessage?.({ data: JSON.stringify(frame) }); }); }
}

beforeEach(() => {
  sockets = [];
  window.WebSocket = FakeSocket;
  vi.stubGlobal('fetch', async (path) => {
    if (path === '/api/status') return new Response(JSON.stringify({ loop: { estTokens: 0, lastTruncateAt: null, context: { hardTokens: null } }, context: { maxTokens: 1000, softRatio: .85 } }));
    if (path === '/api/config') return new Response(JSON.stringify({ groups: [{ group: { id: 'companion' }, values: { 'companion.contextRing': false } }] }));
    throw new Error(`Unexpected request: ${path}`);
  });
});

afterEach(() => {
  act(() => life?.dispose());
  life = null;
  document.body.replaceChildren();
  localStorage.clear();
  delete window.WebSocket;
  vi.unstubAllGlobals();
});

async function mountChat() {
  life = new Lifecycle((err) => { throw err; });
  const root = document.createElement('div');
  document.body.append(root);
  const ui = createConsoleUi({ doc: document, overlayHost: document.body, signal: life.signal, memo: { get: (_, fallback) => fallback, set() {} } });
  await act(() => chatPage.mount({
    root, ui, lifecycle: life, signal: life.signal, capabilities: {},
    router: { navigate() {}, addLeaveGuard: () => ({ dispose() {} }) },
    onError: (err) => { throw err; },
    mountPanel: async () => ({ dispose() {} }),
  }));
  await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(1));
  return { root, socket: sockets[0] };
}

it('renders completed assistant text from the chat stream', async () => {
  const { root, socket } = await mountChat();
  socket.frame({ t: 'init', bot: 'Coo', items: [{ kind: 'assistant', cursor: 17, ts: '2026-11-12T00:00:00+08:00', text: 'A final answer' }], phase: { state: 'idle', running: [] } });
  expect(root.querySelector('.pet-bubble.assistant')?.textContent).toBe('A final answer');
});
