const { isIP } = require('node:net');

const PRIVATE_V4 = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
const LOCAL_NAMES = ['.localhost', '.local', '.internal', '.lan', '.home'];

function httpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isPublicHttp(value) {
  const url = httpUrl(value);
  if (!url || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0' || host.startsWith('[')) return false;
  if (!host.includes('.') || /^[0-9.]+$/.test(host)) return false;
  if (LOCAL_NAMES.some((suffix) => host === suffix.slice(1) || host.endsWith(suffix))) return false;
  return !PRIVATE_V4.test(host);
}

const IPV4_BLOCKED = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0000000, 24],
  [0xc0000200, 24],
  [0xc0586300, 24],
  [0xc0a80000, 16],
  [0xc6120000, 15],
  [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4],
  [0xf0000000, 4],
];

function ipv4Number(address) {
  if (isIP(address) !== 4) return null;
  return address.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function blockedIpv4(address) {
  const value = ipv4Number(address);
  if (value === null) return true;
  return IPV4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === base;
  });
}

function ipv6Number(address) {
  if (isIP(address) !== 6) return null;
  let value = address.toLowerCase().split('%')[0];
  if (value.includes('.')) {
    const at = value.lastIndexOf(':');
    const ipv4 = ipv4Number(value.slice(at + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, at)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const compressed = value.indexOf('::');
  let groups;
  if (compressed >= 0) {
    const left = value.slice(0, compressed).split(':').filter(Boolean);
    const right = value.slice(compressed + 2).split(':').filter(Boolean);
    const zeros = 8 - left.length - right.length;
    if (zeros < 1) return null;
    groups = [...left, ...Array(zeros).fill('0'), ...right];
  } else {
    groups = value.split(':');
  }
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((number, group) => (number << 16n) | BigInt(`0x${group}`), 0n);
}

const IPV6_IETF_PROTOCOL_PREFIX = ipv6Number('2001::') >> 105n;

function blockedIpv6(address) {
  const value = ipv6Number(address);
  if (value === null) return true;
  if (value >> 105n === IPV6_IETF_PROTOCOL_PREFIX) return true;
  if (value >> 32n === 0xffffn) return blockedIpv4(Number(value & 0xffffffffn).toString(16).padStart(8, '0').match(/.{2}/g).map((part) => parseInt(part, 16)).join('.'));
  if (value >> 32n === 0n) return true;
  if (value >> 125n !== 1n) return true;
  if (value >> 96n === 0x20010db8n) return true;
  if (value >> 112n === 0x2002n || value >> 96n === 0x20010000n) return true;
  return false;
}

function isPublicResolvedHost(result) {
  const endpoints = Array.isArray(result?.endpoints) ? result.endpoints : [];
  return endpoints.length > 0 && endpoints.every((endpoint) => {
    if (!endpoint || typeof endpoint.address !== 'string') return false;
    const family = isIP(endpoint.address);
    if (family === 4) return !blockedIpv4(endpoint.address);
    if (family === 6) return !blockedIpv6(endpoint.address);
    return false;
  });
}

function isWebSocketRequest(details) {
  if (details?.resourceType === 'webSocket') return true;
  try {
    const protocol = new URL(String(details?.url ?? '')).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

function sameAddress(left, right) {
  const leftFamily = isIP(String(left ?? '').split('%')[0]);
  const rightFamily = isIP(String(right ?? '').split('%')[0]);
  if (!leftFamily || !rightFamily) return false;
  const leftV4 = leftFamily === 4 ? ipv4Number(left) : mappedIpv4(ipv6Number(left));
  const rightV4 = rightFamily === 4 ? ipv4Number(right) : mappedIpv4(ipv6Number(right));
  if (leftV4 !== null && rightV4 !== null) return leftV4 === rightV4;
  if (leftFamily !== 6 || rightFamily !== 6) return false;
  return ipv6Number(left) === ipv6Number(right);
}

function mappedIpv4(value) {
  if (value === null || value >> 32n !== 0xffffn) return null;
  return Number(value & 0xffffffffn);
}

module.exports = { httpUrl, isPublicHttp, isPublicResolvedHost, isWebSocketRequest, sameAddress };
