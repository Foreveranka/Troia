// Preload (run via `node --import ./block-net.mjs …`) BEFORE any app module, so nothing captures an
// un-patched reference. Pure-JS in-process interception — NOT an OS firewall; it proves the code path
// never reached the network. Every patched entry increments a shared counter and throws. crypto is left
// intact (Ed25519 verify + sha256 must keep working). darwin + Linux portable.

import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';

const state = { attempts: 0 };
globalThis.__troiaNet = state;

const block =
  (name) =>
  (..._args) => {
    state.attempts += 1;
    throw new Error(`network access blocked by verify guard: ${name}`);
  };

// Best-effort assignment: some builtin members are non-writable; skip those rather than crash the preload.
const safe = (obj, key, name) => {
  try {
    obj[key] = block(name);
  } catch {
    /* non-writable — a different vector still covers the actual connection (net) */
  }
};

safe(net, 'connect', 'net.connect');
safe(net, 'createConnection', 'net.createConnection');
safe(net.Socket.prototype, 'connect', 'net.Socket.prototype.connect');
safe(tls, 'connect', 'tls.connect');
safe(dns, 'lookup', 'dns.lookup');
for (const k of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt', 'resolveSrv', 'resolveNs']) {
  if (typeof dns[k] === 'function') safe(dns, k, `dns.${k}`);
}
safe(dnsPromises, 'lookup', 'dns.promises.lookup');
safe(http, 'request', 'http.request');
safe(http, 'get', 'http.get');
safe(https, 'request', 'https.request');
safe(https, 'get', 'https.get');
safe(http2, 'connect', 'http2.connect');
safe(dgram, 'createSocket', 'dgram.createSocket');
globalThis.fetch = block('fetch');
if (typeof globalThis.WebSocket !== 'undefined') globalThis.WebSocket = block('WebSocket');
