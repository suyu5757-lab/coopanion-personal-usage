import { describe, expect, it } from 'vitest';
import { setFileInputFiles, uploadSelector } from '../app/browser-cdp-upload.cjs';

class FakeDebugger {
  attached = false;
  calls = [];
  attach(version) { this.attached = true; this.calls.push(['attach', version]); }
  detach() { this.attached = false; this.calls.push(['detach']); }
  isAttached() { return this.attached; }
  async sendCommand(method, args) {
    this.calls.push([method, args]);
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 42 };
    return {};
  }
}

describe('scoped browser file input selection', () => {
  it('sets only the token-bound file input and detaches the internal debugger', async () => {
    const debuggerClient = new FakeDebugger();
    const token = 'coo-upload-123e4567-e89b-12d3-a456-426614174000';
    await setFileInputFiles(debuggerClient, token, ['/data/video/media/cover.png']);
    expect(debuggerClient.attached).toBe(false);
    expect(debuggerClient.calls).toContainEqual(['DOM.querySelector', {
      nodeId: 1,
      selector: `input[type="file"][data-coo-upload-token="${token}"]`,
    }]);
    expect(debuggerClient.calls).toContainEqual(['DOM.setFileInputFiles', { nodeId: 42, files: ['/data/video/media/cover.png'] }]);
  });

  it('refuses invalid tokens and an already attached debugger', async () => {
    expect(() => uploadSelector('input[type=file]')).toThrow(/invalid file input token/);
    const attached = new FakeDebugger();
    attached.attached = true;
    await expect(setFileInputFiles(attached, 'coo-upload-123e4567-e89b-12d3-a456-426614174000', ['/a.png']))
      .rejects.toThrow(/another debugging session/);
  });

  it('detaches when protocol file selection fails', async () => {
    const failed = new FakeDebugger();
    failed.sendCommand = async (method, args) => {
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 0 };
      return {};
    };
    await expect(setFileInputFiles(failed, 'coo-upload-123e4567-e89b-12d3-a456-426614174000', ['/a.png']))
      .rejects.toThrow(/no longer on the page/);
    expect(failed.attached).toBe(false);
  });
});
