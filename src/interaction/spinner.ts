let spinnerOutputEnabled = true;

export const setSpinnerOutputEnabled = (enabled: boolean): void => {
  spinnerOutputEnabled = enabled;
};

export class Spinner {
  private interval: Timer | null = null;
  private readonly frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentFrame = 0;
  private readonly message: string;

  constructor(message = "Loading...") {
    this.message = message;
  }

  start(): void {
    if (this.interval) {
      return;
    }

    if (!spinnerOutputEnabled) {
      return;
    }

    process.stdout.write("\x1B[?25l");
    this.interval = setInterval(() => {
      const frame = this.frames[this.currentFrame];
      process.stdout.write(`\r${frame} ${this.message}`);
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
  }

  stop(): void {
    if (!spinnerOutputEnabled) {
      return;
    }

    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    process.stdout.write("\r\x1B[K");
    process.stdout.write("\x1B[?25h");
  }

  succeed(message?: string): void {
    this.stop();
    if (message) {
      process.stdout.write(`✓ ${message}\n`);
    }
  }

  fail(message?: string): void {
    this.stop();
    if (message) {
      process.stdout.write(`✗ ${message}\n`);
    }
  }
}
