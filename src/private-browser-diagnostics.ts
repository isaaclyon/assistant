/** Host-only failure metadata. Never include page, request, credential or process output. */
export type PrivateBrowserPhase =
  | "gate-existing" | "gate-create" | "endpoint-preflight"
  | "observer-resolve" | "observer-disconnect" | "page-protect" | "login-protect"
  | "protected-operation" | "cleanup-proxy" | "cleanup-listener" | "cleanup-handoff"
  | "cleanup-submission" | "cleanup-page" | "cleanup-unprotected-page";

const errorCodes = ["ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "EADDRINUSE", "ETIMEDOUT",
  "ENAMETOOLONG", "ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "ERR_UNIX_SOCKET_PATH_TOO_LONG"] as const;
export type PrivateBrowserDiagnostic = Readonly<{
  operation: "input" | "takeover" | "login";
  phase: PrivateBrowserPhase;
  errorCode?: typeof errorCodes[number];
  exitCode?: number;
}>;
export type PrivateBrowserDiagnosticSink = (event: PrivateBrowserDiagnostic) => void | Promise<void>;

export function privateBrowserReporter(operation: PrivateBrowserDiagnostic["operation"], sink?: PrivateBrowserDiagnosticSink) {
  return (phase: PrivateBrowserPhase, error?: unknown): void => {
    if (!sink) return;
    try {
      // Do not invoke getters or serialize errors: even their codes can contain secrets.
      const descriptor = error !== null && (typeof error === "object" || typeof error === "function")
        ? Object.getOwnPropertyDescriptor(error, "code") : undefined;
      const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      const event: PrivateBrowserDiagnostic = Object.freeze({ operation, phase,
        ...(typeof code === "string" && errorCodes.includes(code as typeof errorCodes[number])
          ? { errorCode: code as typeof errorCodes[number] } : {}),
        ...(typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? { exitCode: code } : {}),
      });
      // Do not await diagnostic completion or expose callback failures to cleanup.
      void Promise.resolve(sink(event)).catch(() => {});
    } catch { /* Optional diagnostics must not affect browser safety. */ }
  };
}
