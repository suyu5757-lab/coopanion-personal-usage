import { describe, expect, it } from 'vitest';
const { compositeSnapshotId, mapFramePointToMain, MAX_FRAME_DEPTH } = require('../app/browser-frame-bridge.cjs') as {
  compositeSnapshotId(rootSnapshotId: string, frames: unknown[]): string | null;
  mapFramePointToMain(point: { x: number; y: number }, hops: Array<Record<string, unknown>>):
    | { ok: true; x: number; y: number }
    | { ok: false; reason: string };
  MAX_FRAME_DEPTH: number;
};

const hop = (overrides: Record<string, unknown> = {}) => ({
  connected: true,
  visible: true,
  hit: true,
  transformed: false,
  zoomed: false,
  left: 10,
  top: 15,
  clientLeft: 2,
  clientTop: 3,
  offsetWidth: 100,
  offsetHeight: 100,
  rectWidth: 100,
  rectHeight: 100,
  clientWidth: 96,
  clientHeight: 96,
  parentViewportWidth: 200,
  parentViewportHeight: 160,
  ...overrides,
});

describe('cross-origin frame bridge geometry', () => {
  it('maps a point through verified iframe borders from inner frame to main viewport', () => {
    expect(mapFramePointToMain({ x: 25, y: 20 }, [
      hop(),
      hop({ left: 20, top: 30, clientLeft: 1, clientTop: 1, parentViewportWidth: 1100, parentViewportHeight: 760 }),
    ])).toEqual({ ok: true, x: 58, y: 69 });
  });

  it('rejects frame chains whose geometry or page hit test cannot be proven', () => {
    expect(mapFramePointToMain({ x: 25, y: 20 }, [hop({ transformed: true })])).toEqual({ ok: false, reason: 'unsupported-frame' });
    expect(mapFramePointToMain({ x: 25, y: 20 }, [hop({ rectWidth: 120 })])).toEqual({ ok: false, reason: 'unsupported-frame' });
    expect(mapFramePointToMain({ x: 25, y: 20 }, [hop({ hit: false })])).toEqual({ ok: false, reason: 'covered' });
    expect(mapFramePointToMain({ x: 25, y: 20 }, [hop({ connected: false })])).toEqual({ ok: false, reason: 'unsupported-frame' });
    expect(mapFramePointToMain({ x: 25, y: 20 }, [hop({ left: -30, parentViewportWidth: 10 })])).toEqual({ ok: false, reason: 'offscreen' });
    expect(mapFramePointToMain({ x: 25, y: 20 }, Array.from({ length: MAX_FRAME_DEPTH + 1 }, () => hop())))
      .toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('composite frame snapshots', () => {
  const frame = {
    frameTreeNodeId: 17,
    frameToken: 'frame-a',
    url: 'https://child.example/page',
    parentFrameToken: 'frame-main',
    parentUrl: 'https://parent.example/',
    childSnapshotId: 'snapshot-a',
    viewportWidth: 196,
    viewportHeight: 156,
    hops: [hop()],
  };

  it('stays stable for the same frame evidence and changes when frame identity or content changes', () => {
    const baseline = compositeSnapshotId('root-snapshot', [frame]);
    expect(compositeSnapshotId('root-snapshot', [frame])).toBe(baseline);
    expect(compositeSnapshotId('changed-root', [frame])).not.toBe(baseline);
    expect(compositeSnapshotId('root-snapshot', [{ ...frame, frameToken: 'frame-b' }])).not.toBe(baseline);
    expect(compositeSnapshotId('root-snapshot', [{ ...frame, parentFrameToken: 'parent-b' }])).not.toBe(baseline);
    expect(compositeSnapshotId('root-snapshot', [{ ...frame, url: 'https://child.example/next' }])).not.toBe(baseline);
    expect(compositeSnapshotId('root-snapshot', [{ ...frame, childSnapshotId: 'snapshot-b' }])).not.toBe(baseline);
    expect(compositeSnapshotId('root-snapshot', [{ ...frame, hops: [hop({ left: 11 })] }])).not.toBe(baseline);
    expect(compositeSnapshotId('root-snapshot', [])).not.toBe(baseline);
  });
});
