import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ChildIdentity, ChildManifest, ChildOutcome } from './child-contracts.js';

type Release = () => void | Promise<void>;
/** The subset of ChildArtifacts the supervisor uses. */
export interface ChildArtifactsPort {
  tryBatchLease(batchId: string): Promise<Release | undefined> | Release | undefined;
  readManifest(batchId: string, jobId: string): Promise<ChildManifest | undefined>;
  readOutcome(batchId: string, jobId: string): Promise<ChildOutcome | undefined>;
  writeOutcome(outcome: ChildOutcome): Promise<unknown> | unknown;
  requestCancel(identity: ChildIdentity): Promise<unknown> | unknown;
  isCancelRequested(identity: ChildIdentity): Promise<boolean> | boolean;
  tryWriterLease(batchId: string, jobId: string): Promise<Release | undefined> | Release | undefined;
  jobDir(batchId: string, jobId: string): string;
}
export type SpawnWorkerArgs = { stateDir: string; batchId: string; jobId: string; jobDir: string };
export type ChildControl = { signal: AbortSignal; canRun: () => Promise<boolean>; isCancelled: () => Promise<boolean> };
export type ChildSupervisorOptions = {
  stateDir: string;
  workerPath?: string;
  now?: () => number;
  spawnWorker?: (args: SpawnWorkerArgs) => ChildProcess;
  /** Test seam; defaults to `new ChildArtifacts(stateDir)`. */
  artifacts?: ChildArtifactsPort;
};

export const CHILD_STDOUT_MAX_BYTES = 256 * 1024;
const READY_TIMEOUT_MS = 10_000;
const KILL_AFTER_MS = 5_000;
const GRACE_MS = 5_000;
const POLL_MS = 100;
const RETRY_MS = 250;
const MAX_MESSAGES = 8;
const FIXED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const FAILED_TEXT = 'The subagent failed before producing a report.';
const OUTPUT = {
  cancelled: 'The subagent was cancelled.',
  timed_out: 'The subagent reached its time limit.',
  failed: FAILED_TEXT,
} as const;

type RunState = { interrupted: boolean; cancelRequested: boolean; timedOut: boolean; failed: boolean };

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) return resolve();
  const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});
const once = (release: Release): Release => {
  let called = false;
  return () => { if (called) return; called = true; return release(); };
};

export function createChildSupervisor(options: ChildSupervisorOptions) {
  const now = options.now ?? Date.now;
  let artifactsPromise: Promise<ChildArtifactsPort> | undefined;
  const artifacts = (): Promise<ChildArtifactsPort> => artifactsPromise ??= options.artifacts
    ? Promise.resolve(options.artifacts)
    : import('./child-artifacts.js').then(m => new m.ChildArtifacts(options.stateDir));
  const workerPath = options.workerPath ?? fileURLToPath(new URL('./child-worker.js', import.meta.url));
  const shutdown = new AbortController();
  const runs = new Map<string, Set<Promise<unknown>>>();
  const owned = new Set<Promise<void>>();

  const spawnDefault = (a: SpawnWorkerArgs, cwd: string): ChildProcess => fork(workerPath, [a.stateDir, a.batchId, a.jobId], {
    cwd, execArgv: [], env: { PATH: FIXED_PATH }, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  async function runChild(child: ChildProcess, ident: { batchId: string; jobId: string; launchId: string },
    manifest: ChildManifest, a: ChildArtifactsPort, signal: AbortSignal, control: ChildControl, releaseLease: Release): Promise<RunState> {
    const state: RunState = { interrupted: false, cancelRequested: false, timedOut: false, failed: false };
    const exited = new Promise<void>(resolve => {
      let done = false;
      const fin = (): void => { if (!done) { done = true; resolve(); } };
      child.once('exit', fin);
      child.once('error', () => { if (child.pid === undefined) fin(); });
    });
    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const signalChild = (sig: NodeJS.Signals): void => {
      if (hasExited()) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid!, sig); else child.kill(sig);
      } catch { try { child.kill(sig); } catch { /* handle already gone */ } }
    };
    const terminate = (): void => {
      if (hasExited() || killTimer) return;
      signalChild('SIGTERM');
      killTimer = setTimeout(() => signalChild('SIGKILL'), KILL_AFTER_MS);
    };

    let readyResolve!: () => void;
    const ready = new Promise<void>(r => { readyResolve = r; });
    let isReady = false, messages = 0;
    child.on('message', (m: unknown) => {
      if (++messages > MAX_MESSAGES) { state.failed = true; terminate(); return; }
      if (isReady) return;
      const v = m as Record<string, unknown> | null;
      const keys = v && typeof v === 'object' ? Object.keys(v) : [];
      if (v && keys.length === 4 && v.event === 'ready' && v.batchId === ident.batchId && v.jobId === ident.jobId && v.launchId === ident.launchId) {
        isReady = true; readyResolve();
      } else { state.failed = true; terminate(); }
    });
    let stdoutBytes = 0;
    child.stdout?.on('data', (c: Buffer) => {
      stdoutBytes += c.byteLength;
      if (stdoutBytes > CHILD_STDOUT_MAX_BYTES) { state.failed = true; terminate(); }
    });
    child.stderr?.on('data', () => {});

    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let cancelPolling = false, cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const poll = setInterval(async () => {
      if (cancelPolling || state.cancelRequested || hasExited()) return;
      cancelPolling = true;
      try {
        if (await control.isCancelled().catch(() => false)) {
          await a.requestCancel(ident);
          state.cancelRequested = true;
          cancelTimer = setTimeout(terminate, GRACE_MS);
        }
      } catch { /* retried on the next tick */ } finally { cancelPolling = false; }
    }, POLL_MS);
    timers.push(setTimeout(() => { state.timedOut = true; terminate(); }, Math.max(0, manifest.deadlineAt - now()) + GRACE_MS));
    const onAbort = (): void => { state.interrupted = true; terminate(); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });

    let lease: Promise<void> | undefined;
    const doRelease = (): Promise<void> => lease ??= Promise.resolve(releaseLease()).then(() => undefined);
    try {
      const readyTimer = new Promise<'timeout'>(resolve => { const t = setTimeout(() => resolve('timeout'), READY_TIMEOUT_MS); timers.push(t); });
      const first = await Promise.race([ready.then(() => 'ready' as const), exited.then(() => 'exited' as const), readyTimer]);
      if (first === 'timeout') { state.failed = true; terminate(); }
      if (first === 'ready') await doRelease();
      await exited;
    } finally {
      clearInterval(poll);
      if (cancelTimer) clearTimeout(cancelTimer);
      if (killTimer) clearTimeout(killTimer);
      for (const t of timers) clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      // Ownership ends only after the owned process exited.
      if (!hasExited()) { terminate(); await exited; }
      await doRelease();
    }
    return state;
  }

  async function supervise(batchId: string, jobId: string, control: ChildControl): Promise<ChildOutcome | undefined> {
    const a = await artifacts();
    const signal = AbortSignal.any([control.signal, shutdown.signal]);
    let ran: RunState | undefined;
    for (;;) {
      const lease = await a.tryBatchLease(batchId);
      if (!lease) {
        if (signal.aborted) return undefined;
        await sleep(RETRY_MS, signal);
        if (signal.aborted) return undefined;
        continue;
      }
      let release = once(lease);
      try {
        if (!await control.canRun()) return undefined;
        const manifest = await a.readManifest(batchId, jobId);
        if (!manifest || manifest.batchId !== batchId || manifest.jobId !== jobId) return undefined;
        const writer = await a.tryWriterLease(batchId, jobId);
        if (!writer) {
          // Unknown writer: never spawn, never kill, never report terminal.
          if (signal.aborted) return undefined;
          await release();
          await sleep(RETRY_MS, signal);
          if (signal.aborted) return undefined;
          continue;
        }
        await writer();
        const ident = { batchId, jobId, launchId: manifest.launchId };
        const existing = await a.readOutcome(batchId, jobId);
        if (existing) {
          return existing.batchId === batchId && existing.jobId === jobId && existing.launchId === manifest.launchId ? existing : undefined;
        }
        const cancelled = ran?.cancelRequested || await a.isCancelRequested(ident) || await control.isCancelled().catch(() => false);
        const timedOut = ran?.timedOut || now() >= manifest.deadlineAt;
        const finish = async (status: 'cancelled' | 'timed_out' | 'failed'): Promise<ChildOutcome> => {
          const outcome: ChildOutcome = { ...ident, version: 1, status, output: OUTPUT[status], finishedAt: now() };
          await a.writeOutcome(outcome);
          return outcome;
        };
        if (cancelled) {
          await a.requestCancel(ident);
          return await finish('cancelled');
        }
        if (timedOut) return await finish('timed_out');
        if (ran) {
          if (ran.failed) return await finish('failed');
          if (ran.interrupted || signal.aborted) return undefined;
          return await finish('failed');
        }
        if (signal.aborted) return undefined;

        let child: ChildProcess;
        const args: SpawnWorkerArgs = { stateDir: options.stateDir, batchId, jobId, jobDir: a.jobDir(batchId, jobId) };
        try {
          child = options.spawnWorker ? options.spawnWorker(args) : spawnDefault(args, manifest.workspaceCwd);
        } catch { return await finish('failed'); }
        const done = (async () => {
          ran = await runChild(child, ident, manifest, a, signal, control, release);
        })();
        const tracked = done.then(() => undefined, () => undefined);
        owned.add(tracked);
        try { await done; } finally { owned.delete(tracked); }
        release = once(() => undefined);
      } finally {
        await release();
      }
    }
  }

  return {
    async run(batchId: string, jobId: string, control: ChildControl): Promise<ChildOutcome | undefined> {
      const p = supervise(batchId, jobId, control);
      const set = runs.get(batchId) ?? new Set();
      runs.set(batchId, set);
      set.add(p);
      try { return await p; } finally {
        set.delete(p);
        if (!set.size) runs.delete(batchId);
      }
    },
    async close(): Promise<void> {
      shutdown.abort();
      await Promise.allSettled([...runs.values()].flatMap(s => [...s]));
      await Promise.all([...owned]);
    },
    active(batchId: string): boolean { return (runs.get(batchId)?.size ?? 0) > 0; },
  };
}
