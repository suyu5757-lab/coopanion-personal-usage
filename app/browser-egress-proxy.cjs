const http = require('node:http');
const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
const { isPublicHttp, isPublicResolvedHost, sameAddress } = require('./browser-network-policy.cjs');

const RESOLVE_TIMEOUT_MS = 2500;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_ACTIVE_REQUESTS = 64;
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function withTimeout(work, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function loopback(address) {
  const value = String(address ?? '').toLowerCase().split('%')[0];
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

function cleanHeaders(headers, host) {
  const connectionTokens = new Set(String(headers.connection ?? '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const output = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || connectionTokens.has(key)) continue;
    output[key] = value;
  }
  if (host) output.host = host;
  return output;
}

function requestTarget(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' || !isPublicHttp(url.href)) return null;
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: url.hostname, port, path: `${url.pathname || '/'}${url.search}`, host: url.host };
}

function connectTarget(value) {
  if (typeof value !== 'string' || value.length > 1024) return null;
  let url;
  try { url = new URL(`https://${value}`); } catch { return null; }
  if (url.protocol !== 'https:' || !isPublicHttp(url.href) || url.pathname !== '/' || url.search || url.hash) return null;
  const port = Number(url.port || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname: url.hostname, port };
}

function dialPinned(address, port, connectTcp = net.createConnection) {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: address, port, family: isIP(address) });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(new Error('outbound connection timed out')));
    socket.once('error', finish);
    socket.once('connect', () => {
      if (!sameAddress(socket.remoteAddress, address)) return finish(new Error('outbound peer address changed'));
      finish();
    });
  });
}

function pinnedAgent(address, port, connectTcp) {
  const agent = new http.Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    const socket = connectTcp({ host: address, port, family: isIP(address) });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      if (error) {
        socket.destroy();
        callback(error);
      } else {
        callback(null, socket);
      }
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(new Error('outbound connection timed out')));
    socket.once('error', finish);
    socket.once('connect', () => {
      if (!sameAddress(socket.remoteAddress, address)) return finish(new Error('outbound peer address changed'));
      finish();
    });
    return socket;
  };
  return agent;
}

function createBrowserEgressProxy({ resolveHost, username, password, connectTcp = net.createConnection }) {
  if (typeof resolveHost !== 'function') throw new TypeError('resolveHost is required');
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    throw new TypeError('proxy credentials are required');
  }
  const expectedAuthorization = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  const sockets = new Set();
  const agents = new Set();
  let active = 0;
  let started = false;
  let closed = false;

  const resolvePublic = async (hostname) => {
    const result = await withTimeout(() => resolveHost(hostname), RESOLVE_TIMEOUT_MS, 'destination lookup');
    if (!isPublicResolvedHost(result)) return [];
    return result.endpoints.map((endpoint) => endpoint.address);
  };

  const reserve = () => {
    if (active >= MAX_ACTIVE_REQUESTS) return null;
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  };

  const denyResponse = (response, status) => {
    response.writeHead(status, { connection: 'close', 'content-length': '0' });
    response.end();
  };

  const authorized = (value) => {
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value);
    return actual.length === expectedAuthorization.length && timingSafeEqual(actual, expectedAuthorization);
  };

  const denySocket = (socket, status, headers = {}) => {
    if (socket.destroyed) return;
    const fields = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${fields}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  };

  const server = http.createServer((request, response) => {
    if (!loopback(request.socket.remoteAddress)) return denyResponse(response, 403);
    const release = reserve();
    if (!release) return denyResponse(response, 503);
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      release();
    };
    response.once('finish', finish);
    response.once('close', finish);
    request.once('aborted', finish);

    if (!authorized(request.headers['proxy-authorization'])) {
      response.writeHead(407, {
        connection: 'close',
        'content-length': '0',
        'proxy-authenticate': 'Basic realm="Coopanion Browser"',
      });
      return response.end();
    }

    const target = requestTarget(request.url);
    if (!target) return denyResponse(response, 403);
    void resolvePublic(target.hostname).then((addresses) => {
      if (closed || request.destroyed || response.destroyed) return;
      if (!addresses.length) return denyResponse(response, 403);
      const address = addresses[0];
      const agent = pinnedAgent(address, target.port, connectTcp);
      agents.add(agent);
      const closeAgent = () => {
        agent.destroy();
        agents.delete(agent);
      };
      const outbound = http.request({
        hostname: address,
        port: target.port,
        method: request.method,
        path: target.path,
        headers: cleanHeaders(request.headers, target.host),
        agent,
      }, (upstream) => {
        const headers = cleanHeaders(upstream.headers);
        response.writeHead(upstream.statusCode || 502, upstream.statusMessage, headers);
        upstream.once('end', closeAgent);
        upstream.on('error', () => response.destroy());
        upstream.pipe(response);
      });
      outbound.on('error', () => {
        closeAgent();
        if (!response.headersSent) denyResponse(response, 502);
        else response.destroy();
      });
      request.once('aborted', () => outbound.destroy());
      response.once('close', () => {
        if (!response.writableFinished) outbound.destroy();
        closeAgent();
      });
      request.pipe(outbound);
    }).catch(() => denyResponse(response, 502));
  });

  server.on('connect', (request, client, head) => {
    if (!loopback(client.remoteAddress)) return denySocket(client, 403);
    const release = reserve();
    if (!release) return denySocket(client, 503);
    if (!authorized(request.headers['proxy-authorization'])) {
      release();
      return denySocket(client, 407, { 'Proxy-Authenticate': 'Basic realm="Coopanion Browser"' });
    }
    const target = connectTarget(request.url);
    if (!target) {
      release();
      return denySocket(client, 403);
    }
    const settle = () => release();
    client.once('close', settle);
    void resolvePublic(target.hostname).then(async (addresses) => {
      if (closed || client.destroyed) return;
      if (!addresses.length) return denySocket(client, 403);
      if (client.destroyed) return;
      let upstream;
      for (const address of addresses) {
        try {
          upstream = await dialPinned(address, target.port, connectTcp);
          break;
        } catch { /* try another already-classified public endpoint */ }
      }
      if (!upstream) return denySocket(client, 502);
      if (client.destroyed) return upstream.destroy();
      sockets.add(upstream);
      upstream.once('close', () => sockets.delete(upstream));
      upstream.once('error', () => client.destroy());
      client.once('error', () => upstream.destroy());
      client.once('close', () => upstream.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    }).catch(() => denySocket(client, 502));
  });

  server.on('upgrade', (_request, socket) => denySocket(socket, 403));
  server.on('clientError', (_error, socket) => denySocket(socket, 400));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 0;

  return {
    listen() {
      if (closed) return Promise.reject(new Error('Browser egress proxy is closed'));
      if (started) {
        const address = server.address();
        return Promise.resolve({ host: '127.0.0.1', port: typeof address === 'object' ? address.port : 0 });
      }
      return new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => {
          server.off('error', onError);
          started = true;
          const address = server.address();
          resolve({ host: '127.0.0.1', port: typeof address === 'object' ? address.port : 0 });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
    },
    async close() {
      closed = true;
      for (const agent of agents) agent.destroy();
      agents.clear();
      for (const socket of sockets) socket.destroy();
      if (!started) return;
      await new Promise((resolve) => server.close(() => resolve()));
      started = false;
    },
  };
}

module.exports = { createBrowserEgressProxy };
