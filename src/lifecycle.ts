export interface ShutdownLatch {
  request(reason: string): void;
  wait(): Promise<string>;
}

export function createShutdownLatch(
  onRequested: (reason: string) => void = () => {},
): ShutdownLatch {
  let resolveWait: ((reason: string) => void) | undefined;
  let requestedReason: string | undefined;
  const waitPromise = new Promise<string>((resolve) => {
    resolveWait = resolve;
  });

  return {
    request(reason) {
      if (requestedReason !== undefined) return;
      requestedReason = reason;
      onRequested(reason);
      resolveWait?.(reason);
    },
    wait: () => waitPromise,
  };
}

export interface KeepAliveTimer<THandle> {
  start(): THandle;
  clear(handle: THandle): void;
}

const defaultKeepAliveTimer: KeepAliveTimer<ReturnType<typeof setInterval>> = {
  start: () => setInterval(() => {}, 60_000),
  clear: (handle) => clearInterval(handle),
};

export async function waitForShutdown<
  THandle = ReturnType<typeof setInterval>,
>(
  latch: ShutdownLatch,
  timer: KeepAliveTimer<THandle> = defaultKeepAliveTimer as KeepAliveTimer<THandle>,
): Promise<string> {
  const handle = timer.start();
  try {
    return await latch.wait();
  } finally {
    timer.clear(handle);
  }
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
