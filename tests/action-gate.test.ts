import { describe, expect, it } from 'vitest';
import { ActionGate } from '../core/action-gate.ts';

const gate = (policy: { writes: boolean; imageGeneration?: boolean; imageSaving?: boolean; mediaUpload?: boolean; input?: boolean }) => new ActionGate({
  platformWrites: () => policy.writes,
  imageGeneration: () => policy.imageGeneration ?? false,
  imageSaving: () => policy.imageSaving ?? false,
  mediaUpload: () => policy.mediaUpload ?? false,
  computerInput: () => policy.input ?? true,
  desktopTargetAllowed: () => false,
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

  it('does not let the social-action preference enable image generation, saving or media upload', () => {
    const g = gate({ writes: true });
    expect(g.check({ surface: 'browser', tool: 'browser_chatgpt_generate_image', impact: 'image-generation' }))
      .toMatchObject({ allow: false, refusal: 'not-armed' });
    expect(g.check({ surface: 'browser', tool: 'browser_save_chatgpt_image', impact: 'image-saving' }))
      .toMatchObject({ allow: false, refusal: 'not-armed' });
    expect(g.check({ surface: 'browser', tool: 'browser_upload_media', impact: 'media-upload' }))
      .toMatchObject({ allow: false, refusal: 'not-armed' });
  });

  it('checks image generation, saving and upload preferences independently', () => {
    const policy = { writes: false, imageGeneration: true, imageSaving: false, mediaUpload: true };
    const g = gate(policy);
    expect(g.check({ surface: 'browser', tool: 'browser_chatgpt_generate_image', impact: 'image-generation' }).allow).toBe(true);
    expect(g.check({ surface: 'browser', tool: 'browser_save_chatgpt_image', impact: 'image-saving' }).allow).toBe(false);
    expect(g.check({ surface: 'browser', tool: 'browser_upload_media', impact: 'media-upload' }).allow).toBe(true);
    policy.imageSaving = true;
    expect(g.check({ surface: 'browser', tool: 'browser_save_chatgpt_image', impact: 'image-saving' }).allow).toBe(true);
  });

  it('reads the live settings at each check instead of caching the first answer', () => {
    let writes = false;
    const g = new ActionGate({ platformWrites: () => writes, imageGeneration: () => false, imageSaving: () => false, mediaUpload: () => false, computerInput: () => true, desktopTargetAllowed: () => false });
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

  it('requires a Core confirmation and a current one-use ticket for a desktop task step', async () => {
    let input = true;
    const g = new ActionGate({
      platformWrites: () => false,
      imageGeneration: () => false,
      imageSaving: () => false,
      mediaUpload: () => false,
      computerInput: () => input,
      desktopTargetAllowed: (candidate) => candidate.bundleId === 'com.example.Editor',
    });
    const target = {
      surface: 'desktop' as const,
      instanceId: 'run-test',
      bundleId: 'com.example.Editor',
      executablePath: '/Applications/Editor.app/Contents/MacOS/Editor',
      pid: 11,
      ownerPid: 11,
      processStart: '2026-10-28T00:00:00Z',
      windowId: 3,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      display: null,
      space: null,
      snapshotId: 'snapshot-1',
      captureId: 'capture-1',
      route: 'background-ax' as const,
      source: 'cua-driver' as const,
    };
    const task = {
      taskId: 'session:round-1',
      taskText: 'Type the reviewed paragraph in the editor.',
      target,
      actions: ['computer-input'],
      expiresInMs: 30_000,
      maxSteps: 2,
    };
    const step = { action: 'computer-input', target, expectedChange: 'type reviewed paragraph' };

    expect(await g.requestTaskGrant(task, async () => false, 1_000)).toBeNull();
    const grant = await g.requestTaskGrant(task, async () => true, 2_000);
    expect(grant).not.toBeNull();
    const ticket = g.issueStepTicket(grant!.id, step, 2_001);
    expect(ticket).not.toBeNull();
    expect(g.consumeStepTicket(ticket!.id, step, 2_002)).toBe(true);
    expect(g.consumeStepTicket(ticket!.id, step, 2_003)).toBe(false);

    const nextTicket = g.issueStepTicket(grant!.id, step, 2_004);
    input = false;
    expect(g.consumeStepTicket(nextTicket!.id, step, 2_005)).toBe(false);
  });

  it('rejects an unsupported desktop app before asking for a task grant', async () => {
    let confirmed = 0;
    const g = new ActionGate({
      platformWrites: () => false,
      imageGeneration: () => false,
      imageSaving: () => false,
      mediaUpload: () => false,
      computerInput: () => true,
      desktopTargetAllowed: (target) => target.bundleId === 'com.example.Editor',
    });
    const target = {
      surface: 'desktop' as const,
      instanceId: 'run-test',
      bundleId: 'com.apple.Safari',
      executablePath: '/Applications/Safari.app/Contents/MacOS/Safari',
      pid: 11,
      ownerPid: 11,
      processStart: '2026-10-28T00:00:00Z',
      windowId: 3,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      display: null,
      space: null,
      snapshotId: 'snapshot-1',
      captureId: 'capture-1',
      route: 'background-ax' as const,
      source: 'cua-driver' as const,
    };

    await expect(g.requestTaskGrant({
      taskId: 'desktop:browser-window', taskText: 'Click this browser window.', target,
      actions: ['computer-input'], expiresInMs: 30_000, maxSteps: 1,
    }, async () => { confirmed++; return true; }, 1_000)).resolves.toBeNull();
    expect(confirmed).toBe(0);
  });

  it('does not let image generation permission grant an upload action', async () => {
    const g = new ActionGate({
      platformWrites: () => false,
      imageGeneration: () => true,
      imageSaving: () => false,
      mediaUpload: () => false,
      computerInput: () => false,
      desktopTargetAllowed: () => false,
    });
    const target = {
      surface: 'browser' as const,
      instanceId: 'browser-run',
      origin: 'https://chatgpt.com',
      url: 'https://chatgpt.com/c/test',
      accountRef: 'account-1',
      snapshotId: 'snapshot-1',
      formId: 'composer',
      control: 'image prompt',
    };
    await expect(g.requestTaskGrant({
      taskId: 'browser:round-1', taskText: 'Submit this image prompt.', target,
      actions: ['media-upload'], expiresInMs: 30_000, maxSteps: 1,
    }, async () => true, 1_000)).resolves.toBeNull();
  });

  it('does not let a Browser grant authorize CUA or a CUA grant authorize Browser', async () => {
    const g = new ActionGate({
      platformWrites: () => true,
      imageGeneration: () => true,
      imageSaving: () => true,
      mediaUpload: () => true,
      computerInput: () => true,
      desktopTargetAllowed: (candidate) => candidate.bundleId === 'com.example.Editor',
    });
    const browserTarget = {
      surface: 'browser' as const,
      instanceId: 'browser-run',
      origin: 'https://chatgpt.com',
      url: 'https://chatgpt.com/c/test',
      accountRef: 'account-1',
      snapshotId: 'snapshot-1',
      formId: 'media',
      control: 'save image',
    };
    const desktopTarget = {
      surface: 'desktop' as const,
      instanceId: 'run-test',
      bundleId: 'com.example.Editor',
      executablePath: '/Applications/Editor.app/Contents/MacOS/Editor',
      pid: 11,
      ownerPid: 11,
      processStart: '2026-10-28T00:00:00Z',
      windowId: 3,
      bounds: { x: 0, y: 0, width: 600, height: 400 },
      display: null,
      space: null,
      snapshotId: 'snapshot-1',
      captureId: 'capture-1',
      route: 'background-ax' as const,
      source: 'cua-driver' as const,
    };
    const webGrant = await g.requestTaskGrant({
      taskId: 'browser:save-image', taskText: 'Save this verified image.', target: browserTarget,
      actions: ['image-saving'], expiresInMs: 30_000, maxSteps: 1,
    }, async () => true, 1_000);
    expect(webGrant).not.toBeNull();
    expect(g.issueStepTicket(webGrant!.id, {
      action: 'image-saving', target: desktopTarget, expectedChange: 'save this file',
    }, 1_001)).toBeNull();

    const desktopGrant = await g.requestTaskGrant({
      taskId: 'desktop:edit-text', taskText: 'Edit this local document.', target: desktopTarget,
      actions: ['computer-input'], expiresInMs: 30_000, maxSteps: 1,
    }, async () => true, 2_000);
    expect(desktopGrant).not.toBeNull();
    expect(g.issueStepTicket(desktopGrant!.id, {
      action: 'computer-input', target: browserTarget, expectedChange: 'type into the page',
    }, 2_001)).toBeNull();
    expect(g.check({ surface: 'desktop', tool: 'pet_cua_type', impact: 'computer-input' }))
      .toMatchObject({ allow: false, refusal: 'unverified-target' });
  });

  it('revokes grants and pending tickets when the live permission generation changes', async () => {
    let imageSaving = true;
    const g = new ActionGate({
      platformWrites: () => false,
      imageGeneration: () => false,
      imageSaving: () => imageSaving,
      mediaUpload: () => false,
      computerInput: () => false,
      desktopTargetAllowed: () => false,
    });
    const target = {
      surface: 'browser' as const,
      instanceId: 'browser-run',
      origin: 'https://chatgpt.com',
      url: 'https://chatgpt.com/c/test',
      accountRef: 'account-1',
      snapshotId: 'snapshot-1',
      formId: 'video-media-folder',
      control: 'save-image-sha256',
    };
    const grant = await g.requestTaskGrant({
      taskId: 'browser:save-image', taskText: 'Save the verified image.', target,
      actions: ['image-saving'], files: [{ path: 'image.png', digest: 'a'.repeat(64), bytes: 100, mime: 'image/png' }],
      expiresInMs: 30_000, maxSteps: 1,
    }, async () => true, 1_000);
    const step = {
      action: 'image-saving', target, expectedChange: 'save image',
      files: [{ path: 'image.png', digest: 'a'.repeat(64), bytes: 100, mime: 'image/png' }],
    };
    const ticket = g.issueStepTicket(grant!.id, step, 1_001);
    imageSaving = false;
    expect(g.consumeStepTicket(ticket!.id, step, 1_002)).toBe(false);
    imageSaving = true;
    expect(g.issueStepTicket(grant!.id, step, 1_003)).toBeNull();
  });

  it('refuses a surface and impact pair it does not know', () => {
    expect(gate({ writes: true }).check({ surface: 'desktop', tool: 'some_tool', impact: 'platform-write' }))
      .toMatchObject({ allow: false, refusal: 'not-armed' });
  });
});
