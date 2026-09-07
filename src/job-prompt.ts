interface JobPromptRuntime {
  waitForIdle(): Promise<void>;
  prepare(): Promise<void>;
  prompt(text: string, options: { source: "rpc"; preflightResult: (accepted: boolean) => void }): Promise<void>;
}

// Pi 0.80.10 docs/sdk.md: preflightResult is independent of the full
// run promise. Exceptions after invocation cannot prove rejection.
export async function injectJobPrompt(
  runtime: JobPromptRuntime,
  prompt: string,
  preflightResult: (accepted: boolean) => void = () => {},
  signal?: AbortSignal,
): Promise<void> {
  let abort: (() => void) | undefined;
  try {
    signal?.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Job prompt cancelled before invocation"));
      signal?.addEventListener("abort", abort, { once: true });
    });
    await Promise.race([runtime.waitForIdle(), aborted]);
    await Promise.race([runtime.prepare(), aborted]);
    signal?.throwIfAborted();
  } catch (error) {
    preflightResult(false);
    throw error;
  } finally {
    if (abort) signal?.removeEventListener("abort", abort);
  }
  await runtime.prompt(prompt, { source: "rpc", preflightResult });
}
