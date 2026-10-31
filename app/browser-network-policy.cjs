const { isIP } = require('node:net');

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

function blockedIpv6(address) {
  const value = ipv6Number(address);
  if (value === null) return true;
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

module.exports = { isPublicResolvedHost };
