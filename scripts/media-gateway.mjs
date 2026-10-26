#!/usr/bin/env node
/**
 * Local gateway that lets an isolated assistant runtime use the media stack
 * without holding SSH credentials. It listens on a filesystem Unix socket, accepts
 * one typed JSON request per connection, and forwards it over SSH to the forced,
 * argument-free collector (scripts/media-stack-collector.py) on the media host.
 *
 * It never runs a shell, accepts no host, command or path from the caller, and
 * never retries: an uncertain request is reported, not repeated.
 *
 * Usage: media-gateway.mjs <config.json>
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';

const REQUEST_LIMIT = 2048;
const RESPONSE_LIMIT = 128 * 1024;
const CALL_TIMEOUT_MS = 30_000;
const READ_OPERATIONS = ['health', 'queue', 'upcoming', 'library_search', 'request_search', 'request_list'];
const WRITE_OPERATIONS = ['request_create'];
const HOST = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/;

const failure = (code, message) => ({ ok: false, error: { code, message } });

export function validateGatewayConfig(value) {
  const bad = (what) => { throw new Error(`Invalid media gateway configuration: ${what}`); };
  if (!value || typeof value !== 'object' || value.version !== 1) bad('version');
  const { socketPath, socketMode = 0o660, allowRequests = false, maxConcurrent = 2, ssh } = value;
  if (typeof socketPath !== 'string' || !isAbsolute(socketPath)) bad('socketPath');
  if (!Number.isInteger(socketMode) || socketMode < 0o600 || socketMode > 0o660) bad('socketMode');
  if (typeof allowRequests !== 'boolean') bad('allowRequests');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) bad('maxConcurrent');
  if (!ssh || typeof ssh !== 'object') bad('ssh');
  if (!HOST.test(ssh.host ?? '') || ssh.host.split('.').some((part) => Number(part) > 255)) bad('ssh.host must be a literal IPv4 address');
  if (!USER.test(ssh.user ?? '')) bad('ssh.user');
  for (const key of ['key', 'knownHosts']) if (typeof ssh[key] !== 'string' || !isAbsolute(ssh[key])) bad(`ssh.${key}`);
  const binary = ssh.binary ?? '/usr/bin/ssh';
  if (typeof binary !== 'string' || !isAbsolute(binary)) bad('ssh.binary');
  return { socketPath, socketMode, allowRequests, maxConcurrent, ssh: { host: ssh.host, user: ssh.user, key: ssh.key, knownHosts: ssh.knownHosts, binary } };
}

/** Returns the exact bytes to send to the collector, or a typed failure. */
export function parseRequest(line, allowRequests) {
  let request;
  try { request = JSON.parse(line); } catch { return failure('INPUT_INVALID', 'Request must be one JSON object'); }
  if (!request || typeof request !== 'object' || Array.isArray(request)) return failure('INPUT_INVALID', 'Request must be one JSON object');
  const keys = Object.keys(request);
  if (keys.some((key) => key !== 'op' && key !== 'args') || typeof request.op !== 'string') return failure('INPUT_INVALID', 'Request must be {"op":string,"args":object}');
  const args = request.args ?? {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return failure('INPUT_INVALID', 'Request args must be an object');
  if (WRITE_OPERATIONS.includes(request.op)) {
    if (!allowRequests) return failure('REQUESTS_DISABLED', 'Creating media requests is disabled on this gateway');
  } else if (!READ_OPERATIONS.includes(request.op)) return failure('OPERATION_UNKNOWN', 'Unknown operation');
  return { body: JSON.stringify({ op: request.op, args }) };
}

function sshArguments(ssh) {
  return ['-F', '/dev/null', '-T', '-i', ssh.key,
    '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${ssh.knownHosts}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ConnectTimeout=8', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'LogLevel=ERROR',
    `${ssh.user}@${ssh.host}`];
}

function forward(ssh, body, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(ssh.binary, sshArguments(ssh), { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin' } });
    let output = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(failure('MEDIA_TIMEOUT', 'The media host did not answer in time')); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      output = Buffer.concat([output, chunk]);
      if (output.length > RESPONSE_LIMIT) { child.kill('SIGKILL'); finish(failure('MEDIA_RESPONSE_TOO_LARGE', 'The media host response is too large')); }
    });
    child.on('error', () => finish(failure('MEDIA_UNAVAILABLE', 'The media host is unavailable')));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(output.toString('utf8'));
        if (parsed && typeof parsed === 'object' && typeof parsed.ok === 'boolean') return finish(parsed);
      } catch { /* fall through */ }
      finish(failure('MEDIA_UNAVAILABLE', 'The media host is unavailable'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(body);
  });
}

export function createGateway(rawConfig, options = {}) {
  const config = validateGatewayConfig(rawConfig);
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  let active = 0;
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let handled = false;
    const reply = (value) => { socket.end(`${JSON.stringify(value)}\n`); };
    socket.setTimeout(timeoutMs + 5_000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', async (chunk) => {
      if (handled) return;
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(10);
      if (newline < 0 && buffered.length <= REQUEST_LIMIT) return;
      handled = true;
      if (newline < 0 || newline > REQUEST_LIMIT) return reply(failure('INPUT_INVALID', 'Request is too large or unterminated'));
      const parsed = parseRequest(buffered.subarray(0, newline).toString('utf8'), config.allowRequests);
      if (!('body' in parsed)) return reply(parsed);
      if (active >= config.maxConcurrent) return reply(failure('MEDIA_BUSY', 'Too many media requests are running'));
      active += 1;
      try { reply(await forward(config.ssh, parsed.body, timeoutMs)); } finally { active -= 1; }
    });
  });
  return {
    async listen() {
      if (existsSync(config.socketPath)) {
        if (!lstatSync(config.socketPath).isSocket()) throw new Error('Gateway socket path is occupied by a non-socket');
        unlinkSync(config.socketPath);
      }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, () => { server.off('error', reject); resolve(); }); });
      chmodSync(config.socketPath, config.socketMode);
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (process.argv.length !== 3 || !path) { console.error('usage: media-gateway.mjs <config.json>'); process.exit(2); }
  const gateway = createGateway(JSON.parse(readFileSync(path, 'utf8')));
  await gateway.listen();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void gateway.close().then(() => process.exit(0)); });
}
