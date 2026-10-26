/**
 * A scripted ACP agent for the opencode World's tests. It speaks the same nd-JSON as
 * `opencode acp`, asks for permission before writing, writes through the client's fs method,
 * and lets a prompt be cancelled. The prompt text picks the script.
 */
import { join } from 'node:path';

let nextId = 1;
let buffer = '';
const pending = new Map();
const sessions = new Map();
const active = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } });
}

function chunk(sessionId, text) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_1', content: { type: 'text', text } } } });
}

function toolCall(sessionId, path) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: path, kind: 'edit', status: 'pending', locations: [{ path }], rawInput: { filePath: path } },
    },
  });
}

function toolUpdate(sessionId, status, path, content) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status, ...(path ? { locations: [{ path }] } : {}), ...(content ? { content } : {}) } },
  });
}

function commandCall(sessionId, command, output) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call_cmd', title: command, kind: 'execute', status: 'in_progress', rawInput: { command } } },
  });
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: 'call_cmd', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }] } },
  });
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const session = sessions.get(sessionId);
  const text = (params.prompt ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  let cancelled = false;
  const stopped = new Promise((resolve) => active.set(sessionId, { cancel: () => { cancelled = true; resolve(); } }));
  try {
    if (text.includes('SLOW')) {
      chunk(sessionId, 'working');
      await stopped;
      active.delete(sessionId);
      respond(id, { stopReason: 'cancelled' });
      return;
    }
    if (text.includes('FAIL')) {
      active.delete(sessionId);
      fail(id, 'fake failure');
      return;
    }
    if (text.includes('WRITE')) {
      const name = /WRITE\s+(\S+)/.exec(text)?.[1] ?? 'hello.txt';
      const path = join(session.cwd, name);
      toolCall(sessionId, path);
      const decision = await request('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'call_1', title: path, kind: 'edit', rawInput: { filePath: path }, locations: [{ path }] },
        options: [
          { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const outcome = decision?.outcome;
      if (cancelled) {
        active.delete(sessionId);
        respond(id, { stopReason: 'cancelled' });
        return;
      }
      if (!outcome || outcome.outcome !== 'selected' || outcome.optionId !== 'once' && outcome.optionId !== 'always') {
        toolUpdate(sessionId, 'failed', path);
        chunk(sessionId, 'Denied');
        active.delete(sessionId);
        respond(id, { stopReason: 'end_turn' });
        return;
      }
      try {
        await request('fs/write_text_file', { sessionId, path, content: 'hello from opencode' });
        commandCall(sessionId, 'printf hello', 'hello from opencode');
        toolUpdate(sessionId, 'completed', path, [{ type: 'diff', path, oldText: '', newText: 'hello from opencode' }]);
        chunk(sessionId, 'Done');
      } catch (error) {
        toolUpdate(sessionId, 'failed', path);
        chunk(sessionId, `Could not write: ${error.message}`);
      }
      active.delete(sessionId);
      respond(id, { stopReason: 'end_turn' });
      return;
    }
    chunk(sessionId, 'pong');
    active.delete(sessionId);
    respond(id, { stopReason: 'end_turn' });
  } catch (error) {
    active.delete(sessionId);
    fail(id, error instanceof Error ? error.message : String(error));
  }
}

async function onRequest(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    respond(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
      agentInfo: { name: 'Fake opencode', version: '1.0.0' },
    });
    return;
  }
  if (method === 'session/new') {
    const sessionId = `ses_${sessions.size + 1}`;
    sessions.set(sessionId, { cwd: params.cwd });
    respond(id, { sessionId });
    return;
  }
  if (method === 'session/resume') {
    respond(id, {});
    return;
  }
  if (method === 'session/prompt') {
    void prompt(id, params);
    return;
  }
  fail(id, `unknown method ${method}`);
}

function onMessage(message) {
  if (message.method && message.id !== undefined) {
    void onRequest(message);
    return;
  }
  if (message.id !== undefined) {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
    return;
  }
  if (message.method === 'session/cancel') {
    active.get(message.params?.sessionId)?.cancel();
  }
}

process.stdin.on('data', (data) => {
  buffer += data.toString();
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      onMessage(JSON.parse(line));
    } catch {
      // a broken line is the harness's problem; the next one is read
    }
  }
});
process.stdin.on('end', () => process.exit(0));
