import { describe, expect, it } from 'vitest';
import { imagePointToViewport } from '../app/browser-visual-point.cjs';

describe('screenshot image coordinates', () => {
  it('maps resized image pixels proportionally to the recorded CSS viewport', () => {
    expect(imagePointToViewport(
      { imageWidth: 550, imageHeight: 366, viewportWidth: 1100, viewportHeight: 732 },
      { x: 25, y: 40 },
    )).toEqual({ x: 50, y: 80 });
  });

  it('rejects points outside the image and invalid image-to-viewport dimensions', () => {
    const capture = { imageWidth: 550, imageHeight: 366, viewportWidth: 1100, viewportHeight: 732 };
    expect(imagePointToViewport(capture, { x: 550, y: 20 })).toBe(null);
    expect(imagePointToViewport(capture, { x: 20, y: -1 })).toBe(null);
    expect(imagePointToViewport({ ...capture, viewportWidth: 0 }, { x: 20, y: 20 })).toBe(null);
  });
});
