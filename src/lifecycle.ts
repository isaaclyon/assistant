export interface ShutdownLatch {
  request(reason: string): void;
  wait(): Promise<string>;
}

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
