const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_CYAN = "\x1b[36m";

export const PENDING_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export const PENDING_SPINNER_INTERVAL_MS = 80;

export const stylePendingIndicator = (frame: string, message: string): string =>
  `${ANSI_CYAN}${frame}${ANSI_RESET} ${ANSI_DIM}${message}${ANSI_RESET}`;

export interface SpinnerTicker {
  stop(): void;
}

export interface SpinnerTickerOptions {
  emitInitialFrame?: boolean;
  intervalMs?: number;
}

export const createSpinnerTicker = (
  onFrame: (frame: string) => void,
  options: SpinnerTickerOptions = {}
): SpinnerTicker => {
  const intervalMs = options.intervalMs ?? PENDING_SPINNER_INTERVAL_MS;
  const emitInitialFrame = options.emitInitialFrame ?? true;
  let frameIndex = 0;

  const emit = (): void => {
    onFrame(PENDING_SPINNER_FRAMES[frameIndex]);
  };

  if (emitInitialFrame) {
    emit();
  }

  let intervalHandle: ReturnType<typeof setInterval> | null = setInterval(
    () => {
      frameIndex = (frameIndex + 1) % PENDING_SPINNER_FRAMES.length;
      emit();
    },
    intervalMs
  );

  return {
    stop(): void {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
  };
};
