export interface ShutdownLatch {
  request(reason: string): void;
  wait(): Promise<string>;
}

// EX_TEMPFAIL. The daemon exits with this code on a restart request so the
// systemd unit's `Restart=on-failure` policy brings the process back; a clean
// (code 0) shutdown would not restart. See docs/adr/0006.
export const RESTART_EXIT_CODE = 75;

export const restartExitCode = (reason: string): number =>
  reason === "restart" ? RESTART_EXIT_CODE : 0;

export function createShutdownLatch(
  onRequested: (reason: string) => void = () => {},
): ShutdownLatch {
  let resolveWait!: (reason: string) => void;
  let requestedReason: string | undefined;
  const waitPromise = new Promise<string>((resolve) => {
    resolveWait = resolve;
  });

  return {
    request(reason) {
      if (requestedReason !== undefined) return;
      requestedReason = reason;
      onRequested(reason);
      resolveWait(reason);
    },
    wait: () => waitPromise,
  };
}

export function bindProcessShutdownSignals(latch: ShutdownLatch): () => void {
  const onSigint = (): void => latch.request("SIGINT");
  const onSigterm = (): void => latch.request("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}
