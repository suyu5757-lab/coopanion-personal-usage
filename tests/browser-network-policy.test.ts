import { describe, expect, it } from 'vitest';
const { httpUrl, isPublicHttp, isPublicResolvedHost, isWebSocketRequest, sameAddress } = require('../app/browser-network-policy.cjs') as {
  httpUrl(value: string): URL | null;
  isPublicHttp(value: string): boolean;
  isPublicResolvedHost(result: { endpoints?: Array<{ address: string }> }): boolean;
  isWebSocketRequest(details: { url?: string; resourceType?: string }): boolean;
  sameAddress(left: string, right: string): boolean;
};

describe('Browser public URL policy', () => {
  it('allows named public HTTP pages without URL credentials', () => {
    expect(isPublicHttp('https://example.com/path')).toBe(true);
    expect(httpUrl('https://example.com')).toBeInstanceOf(URL);
    expect(isPublicHttp('https://user:secret@example.com/')).toBe(false);
    expect(isPublicHttp('http://localhost/')).toBe(false);
    expect(isPublicHttp('https://127.0.0.1/')).toBe(false);
  });
});

describe('Browser resolved-address policy', () => {
  it('accepts globally routable IPv4 and IPv6 endpoints', () => {
    expect(isPublicResolvedHost({ endpoints: [{ address: '93.184.216.34' }] })).toBe(true);
    expect(isPublicResolvedHost({ endpoints: [{ address: '2001:4860:4860::8888' }] })).toBe(true);
    expect(isPublicResolvedHost({ endpoints: [{ address: '::ffff:8.8.8.8' }] })).toBe(true);
  });

  it('rejects private, loopback, link-local, reserved and malformed endpoints', () => {
    for (const address of [
      '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
      '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
      '224.0.0.1', '240.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
      '2001::1', '2001:1::1', '2001:2::1', '2001:30::1', '2001:db8::1', '2002::7f00:1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'not-an-ip',
    ]) {
      expect(isPublicResolvedHost({ endpoints: [{ address }] }), address).toBe(false);
    }
    expect(isPublicResolvedHost({ endpoints: [{ address: '8.8.8.8' }, { address: '10.0.0.1' }] })).toBe(false);
    expect(isPublicResolvedHost({ endpoints: [] })).toBe(false);
  });

  it('refuses WebSocket requests by resource type or URL scheme', () => {
    expect(isWebSocketRequest({ url: 'ws://127.0.0.1/socket', resourceType: 'other' })).toBe(true);
    expect(isWebSocketRequest({ url: 'wss://example.com/socket', resourceType: 'other' })).toBe(true);
    expect(isWebSocketRequest({ url: 'https://example.com/socket', resourceType: 'webSocket' })).toBe(true);
    expect(isWebSocketRequest({ url: 'https://example.com/api', resourceType: 'xhr' })).toBe(false);
  });

  it('compares IPv4, IPv6, and IPv4-mapped socket addresses', () => {
    expect(sameAddress('93.184.216.34', '93.184.216.34')).toBe(true);
    expect(sameAddress('2001:4860:4860::8888', '2001:4860:4860:0:0:0:0:8888')).toBe(true);
    expect(sameAddress('::ffff:8.8.8.8', '8.8.8.8')).toBe(true);
    expect(sameAddress('93.184.216.34', '127.0.0.1')).toBe(false);
  });
});
