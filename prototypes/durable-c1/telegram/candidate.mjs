import { execFileSync } from 'node:child_process';
import { realpathSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const telegramCandidateSha = 'b463aec0683969f8c9b6075bb2f258f6ca382c5c';
// Default is the approved adjacent repository layout; override for an explicit clone.
export function verifiedTelegramCandidate(source = process.env.PI_DURABLE_C1_TELEGRAM_SOURCE ?? resolve('../../../pi-telegram/.worktrees/durable-c1')) {
  const directory = realpathSync(source);
  const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', timeout: 10000 }).trim();
  if (git('rev-parse', 'HEAD') !== telegramCandidateSha) throw new Error('Telegram prototype candidate SHA mismatch');
  if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('Telegram prototype candidate has tracked modifications');
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const entry = metadata.exports['./prototype-durable'];
  if (entry !== './api/prototype-durable.mjs') throw new Error('Telegram prototype public subpath mismatch');
  return pathToFileURL(join(directory, entry)).href;
}
