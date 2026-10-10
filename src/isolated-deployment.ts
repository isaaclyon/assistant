export interface IsolatedDeploymentOperations {
  /** Read-only validation and immutable release staging; no live writers stop. */
  preflight(): Promise<void>;
  hold(): Promise<void>;
  stopAll(): Promise<void>;
  assertQuiescent(): Promise<void>;
  checkpoint(): Promise<void>;
  migrate(): Promise<void>;
  install(): Promise<void>;
  markStarted(): Promise<void>;
  authorize(): Promise<void>;
  start(): Promise<void>;
  ready(): Promise<void>;
  revoke(): Promise<void>;
  enable(): Promise<void>;
  complete(): Promise<void>;
}

/** One transition covers both systemd managers and the trusted poller. Any
 * failure after the hold stops every writer; it never restores older state. */
export async function activateIsolatedDeployment(operations: IsolatedDeploymentOperations, signal?: AbortSignal): Promise<void> {
  const check = () => signal?.throwIfAborted();
  check();
  await operations.preflight();
  check();
  try {
    await operations.hold();
    check();
    await operations.stopAll();
    check();
    await operations.assertQuiescent();
    await operations.checkpoint();
    check();
    await operations.migrate();
    check();
    await operations.install();
    check();
    await operations.markStarted();
    await operations.authorize();
    check();
    await operations.start();
    check();
    await operations.ready();
    check();
    await operations.revoke();
    await operations.enable();
    check();
    await operations.complete();
  } catch (cause) {
    let stopped = true;
    try { await operations.revoke(); } catch { stopped = false; }
    try { await operations.stopAll(); await operations.assertQuiescent(); } catch { stopped = false; }
    throw new Error(stopped
      ? "Deployment held: writers are stopped and disabled; retain the checkpoint and reconcile accepted work"
      : "Deployment held, but writer shutdown could not be verified; administrator intervention is required", { cause });
  }
}
