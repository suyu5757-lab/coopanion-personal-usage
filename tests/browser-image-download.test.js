import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generatedImagePath,
  imageFormat,
  isChatGPTImageDownloadUrl,
  isChatGPTPageUrl,
  verifyGeneratedImage,
} from '../app/browser-image-download.cjs';

let tempDir;
afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('ChatGPT image download boundary', () => {
  it('accepts only the signed-in ChatGPT page and its image file origins', () => {
    expect(isChatGPTPageUrl('https://chatgpt.com/c/abc')).toBe(true);
    expect(isChatGPTPageUrl('https://chat.openai.com/')).toBe(true);
    expect(isChatGPTPageUrl('http://chatgpt.com/')).toBe(false);
    expect(isChatGPTPageUrl('https://chatgpt.com.example.org/')).toBe(false);
    expect(isChatGPTImageDownloadUrl('blob:https://chatgpt.com/id')).toBe(true);
    expect(isChatGPTImageDownloadUrl('https://files.oaiusercontent.com/image.png')).toBe(true);
    expect(isChatGPTImageDownloadUrl('https://example.org/image.png')).toBe(false);
  });

  it('recognizes PNG, JPEG and WebP signatures', () => {
    expect(imageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(imageFormat(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe('jpeg');
    expect(imageFormat(Buffer.from('RIFF0000WEBP'))).toBe('webp');
    expect(imageFormat(Buffer.from('not an image'))).toBe(null);
  });

  it('allocates a new media filename and verifies the downloaded file bytes', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'coopanion-chatgpt-image-'));
    const target = generatedImagePath(join(tempDir, 'video', 'media'), 'image/png');
    expect(target.name).toMatch(/^chatgpt-image-\d+-[\da-f-]+\.png$/);
    writeFileSync(target.file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]));
    expect(verifyGeneratedImage(target.file, 'image/png')).toEqual({ bytes: 9, format: 'png' });
    expect(() => verifyGeneratedImage(target.file, 'image/jpeg')).toThrow(/contents do not match/);
  });

  it('rejects unsupported output MIME types before writing into the media folder', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'coopanion-chatgpt-image-'));
    expect(() => generatedImagePath(join(tempDir, 'video', 'media'), 'application/zip')).toThrow(/PNG, JPEG or WebP/);
  });
});
