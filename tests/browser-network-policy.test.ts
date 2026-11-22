import { describe, expect, it } from 'vitest';
type ResolvedHost = { endpoints?: Array<{ address: string }> };
type DestinationCheck = { allowed: boolean; reason: string | null; blockedFamilies?: string[] };
type TimeoutRunner = <T>(work: () => Promise<T>) => Promise<T>;

const { checkPublicDestination, httpUrl, isPublicHttp, isPublicResolvedHost, isWebSocketRequest, sameAddress } = require('../app/browser-network-policy.cjs') as {
  checkPublicDestination(
    value: string,
    resolveHost: (hostname: string) => Promise<ResolvedHost>,
    withTimeout?: TimeoutRunner,
  ): Promise<DestinationCheck>;
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

describe('Browser public destination preflight', () => {
  const noTimeout: TimeoutRunner = (work) => work();

  it('allows a public HTTPS URL only after a public resolver result', async () => {
    const check = await checkPublicDestination(
      'https://example.com/',
      async () => ({ endpoints: [{ address: '93.184.216.34' }] }),
      noTimeout,
    );
    expect(check).toEqual({ allowed: true, reason: null });
  });

  it('reports an empty resolver result without making a Browser page claim', async () => {
    const check = await checkPublicDestination('https://example.com/', async () => ({ endpoints: [] }), noTimeout);
    expect(check).toEqual({ allowed: false, reason: 'no-addresses' });
  });

  it('reports a blocked address when any resolver endpoint is non-public', async () => {
    const check = await checkPublicDestination(
      'https://example.com/',
      async () => ({ endpoints: [{ address: '93.184.216.34' }, { address: '127.0.0.1' }] }),
      noTimeout,
    );
    expect(check).toEqual({ allowed: false, reason: 'non-public-address', blockedFamilies: ['ipv4'] });
  });

  it('reports an invalid endpoint class without returning address values', async () => {
    const check = await checkPublicDestination(
      'https://example.com/', async () => ({ endpoints: [{ address: 'not-an-ip' }] }), noTimeout,
    );
    expect(check).toEqual({ allowed: false, reason: 'non-public-address', blockedFamilies: ['invalid'] });
  });

  it('distinguishes resolver timeouts and failures without returning resolver details', async () => {
    const timeout = await checkPublicDestination(
      'https://example.com/', async () => ({ endpoints: [] }),
      async () => { throw new Error('public destination check timed out'); },
    );
    const failure = await checkPublicDestination(
      'https://example.com/', async () => { throw new Error('private resolver detail'); }, noTimeout,
    );
    expect(timeout).toEqual({ allowed: false, reason: 'resolution-timeout' });
    expect(failure).toEqual({ allowed: false, reason: 'resolution-failed' });
  });

  it('detects RFC 2544 Fake-IP-only DNS results without ever permitting 198.18.0.0/15 as a public address', () => {
    const { isFakeIpOnlyResult } = require('../app/browser-network-policy.cjs') as {
      isFakeIpOnlyResult(result: ResolvedHost): boolean;
    };
    expect(isFakeIpOnlyResult({ endpoints: [{ address: '198.18.0.133' }] })).toBe(true);
    expect(isFakeIpOnlyResult({ endpoints: [{ address: '198.19.255.1' }] })).toBe(true);
    expect(isFakeIpOnlyResult({ endpoints: [{ address: '127.0.0.1' }] })).toBe(false);
    expect(isFakeIpOnlyResult({ endpoints: [{ address: '198.18.0.133' }, { address: '127.0.0.1' }] })).toBe(false);
    expect(isFakeIpOnlyResult({ endpoints: [{ address: '93.184.216.34' }] })).toBe(false);
    expect(isPublicResolvedHost({ endpoints: [{ address: '198.18.0.133' }] })).toBe(false);
  });
});
