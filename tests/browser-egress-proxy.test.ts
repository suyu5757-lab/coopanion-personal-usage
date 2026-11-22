import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import net from 'node:net';

const { createBrowserEgressProxy } = require('../app/browser-egress-proxy.cjs') as {
  createBrowserEgressProxy(options: {
    resolveHost(hostname: string): Promise<{ endpoints: Array<{ address: string }> }>;
    username: string;
    password: string;
    connectTcp(options: { host: string; port: number; family: number }): net.Socket;
  }): { listen(): Promise<{ host: string; port: number }>; close(): Promise<void> };
};
const PROXY_AUTH = `Basic ${Buffer.from('fixture:fixture-secret').toString('base64')}`;

function listen(server: http.Server | net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('fixture listener has no TCP port'));
      resolve(address.port);
    });
  });
}

function close(server: http.Server | net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function clientRequest(port: number, options: http.RequestOptions, body = ''): Promise<{
  status: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, ...options }, (response) => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { content += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: content }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

describe('Browser pinned egress proxy', () => {
  let proxy: ReturnType<typeof createBrowserEgressProxy> | undefined;
  let fixture: http.Server | net.Server | undefined;

  afterEach(async () => {
    await proxy?.close();
    if (fixture?.listening) await close(fixture);
    proxy = undefined;
    fixture = undefined;
  });

  it('routes HTTP to the classified numeric address and strips proxy credentials', async () => {
    let targetPath = '';
    let targetHost = '';
    let forwardedProxyAuth: string | undefined;
    const target = http.createServer((request, response) => {
      targetPath = request.url ?? '';
      targetHost = String(request.headers.host ?? '');
      forwardedProxyAuth = request.headers['proxy-authorization'];
      response.writeHead(302, { location: 'http://next.example/image.png' });
      response.end('redirect');
    });
    fixture = target;
    const targetPort = await listen(target);
    const connected: Array<{ host: string; port: number; family: number }> = [];
    proxy = createBrowserEgressProxy({
      resolveHost: async (hostname) => {
        if (hostname === 'origin.example') return { endpoints: [{ address: '93.184.216.34' }] };
        if (hostname === 'next.example') return { endpoints: [{ address: '127.0.0.1' }] };
        throw new Error('unexpected fixture hostname');
      },
      username: 'fixture',
      password: 'fixture-secret',
      connectTcp: (options) => {
        connected.push(options);
        const socket = net.createConnection({ host: '127.0.0.1', port: targetPort });
        Object.defineProperty(socket, 'remoteAddress', { configurable: true, get: () => options.host });
        return socket;
      },
    });
    const address = await proxy.listen();

    const result = await clientRequest(address.port, {
      method: 'GET',
      path: 'http://origin.example/asset?id=7',
      headers: { host: 'origin.example', 'proxy-authorization': PROXY_AUTH },
    });

    expect(result.status).toBe(302);
    expect(result.headers.location).toBe('http://next.example/image.png');
    expect(result.body).toBe('redirect');
    expect(connected).toEqual([{ host: '93.184.216.34', port: 80, family: 4 }]);
    expect(targetPath).toBe('/asset?id=7');
    expect(targetHost).toBe('origin.example');
    expect(forwardedProxyAuth).toBeUndefined();

    const redirected = await clientRequest(address.port, {
      method: 'GET',
      path: 'http://next.example/image.png',
      headers: { host: 'next.example', 'proxy-authorization': PROXY_AUTH },
    });
    expect(redirected.status).toBe(403);
    expect(connected).toHaveLength(1);
  });

  it('denies a private DNS answer before opening a socket', async () => {
    const connected: unknown[] = [];
    proxy = createBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: '127.0.0.1' }] }),
      username: 'fixture',
      password: 'fixture-secret',
      connectTcp: (options) => {
        connected.push(options);
        return net.createConnection(options);
      },
    });
    const address = await proxy.listen();

    const result = await clientRequest(address.port, {
      method: 'GET',
      path: 'http://private.example/internal',
      headers: { host: 'private.example', 'proxy-authorization': PROXY_AUTH },
    });

    expect(result.status).toBe(403);
    expect(connected).toEqual([]);
  });

  it('requires the Browser session proxy credential before resolving a target', async () => {
    let resolveCalls = 0;
    const connected: unknown[] = [];
    proxy = createBrowserEgressProxy({
      resolveHost: async () => {
        resolveCalls += 1;
        return { endpoints: [{ address: '93.184.216.34' }] };
      },
      username: 'fixture',
      password: 'fixture-secret',
      connectTcp: (options) => {
        connected.push(options);
        return net.createConnection(options);
      },
    });
    const address = await proxy.listen();

    const result = await clientRequest(address.port, {
      method: 'GET',
      path: 'http://origin.example/unauthorized',
      headers: { host: 'origin.example' },
    });

    expect(result.status).toBe(407);
    expect(result.headers['proxy-authenticate']).toBe('Basic realm="Coopanion Browser"');
    expect(resolveCalls).toBe(0);
    expect(connected).toEqual([]);
  });

  it('rejects an outbound socket whose peer differs from the classified address', async () => {
    let received = false;
    const target = http.createServer((_request, response) => {
      received = true;
      response.end('unexpected');
    });
    fixture = target;
    const targetPort = await listen(target);
    proxy = createBrowserEgressProxy({
      resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }] }),
      username: 'fixture',
      password: 'fixture-secret',
      connectTcp: () => net.createConnection({ host: '127.0.0.1', port: targetPort }),
    });
    const address = await proxy.listen();

    const result = await clientRequest(address.port, {
      method: 'GET',
      path: 'http://origin.example/private',
      headers: { host: 'origin.example', 'proxy-authorization': PROXY_AUTH },
    });

    expect(result.status).toBe(502);
    expect(received).toBe(false);
  });

  it('pins HTTPS CONNECT to a classified endpoint and relays the tunnel', async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    fixture = echo;
    const targetPort = await listen(echo);
    const connected: Array<{ host: string; port: number; family: number }> = [];
    proxy = createBrowserEgressProxy({
      resolveHost: async (hostname) => {
        expect(hostname).toBe('secure.example');
        return { endpoints: [{ address: '8.8.8.8' }] };
      },
      username: 'fixture',
      password: 'fixture-secret',
      connectTcp: (options) => {
        connected.push(options);
        const socket = net.createConnection({ host: '127.0.0.1', port: targetPort });
        Object.defineProperty(socket, 'remoteAddress', { configurable: true, get: () => options.host });
        return socket;
      },
    });
    const address = await proxy.listen();

    const echoed = await new Promise<string>((resolve, reject) => {
      const request = http.request({
        hostname: address.host,
        port: address.port,
        method: 'CONNECT',
        path: 'secure.example:443',
        headers: { 'proxy-authorization': PROXY_AUTH },
      });
      request.once('error', reject);
      request.once('connect', (response, socket) => {
        if (response.statusCode !== 200) return reject(new Error(`unexpected CONNECT status ${response.statusCode}`));
        socket.once('data', (chunk) => { socket.end(); resolve(chunk.toString()); });
        socket.write('fixture-tunnel');
      });
      request.end();
    });

    expect(echoed).toBe('fixture-tunnel');
    expect(connected).toEqual([{ host: '8.8.8.8', port: 443, family: 4 }]);
  });
});
