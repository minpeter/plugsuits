export interface SignalHandlerConfig {
  onCleanup: () => void;
  onFatalCleanup: (exitCode: number) => never;
}

export const registerSignalHandlers = (config: SignalHandlerConfig): void => {
  const { onCleanup, onFatalCleanup } = config;

  process.once("exit", () => {
    onCleanup();
  });

  process.once("SIGINT", () => {
    onFatalCleanup(0);
  });

  process.once("SIGTERM", () => {
    onFatalCleanup(143);
  });

  process.once("SIGHUP", () => {
    onFatalCleanup(129);
  });

  process.once("SIGQUIT", () => {
    onFatalCleanup(131);
  });

  process.once("uncaughtException", (error: unknown) => {
    console.error("Fatal error:", error);
    onFatalCleanup(1);
  });

  process.once("unhandledRejection", (reason: unknown) => {
    console.error("Unhandled rejection:", reason);
    onFatalCleanup(1);
  });
};
