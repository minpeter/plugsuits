export const colors = {
  blue: "\u001b[94m",
  yellow: "\u001b[93m",
  green: "\u001b[92m",
  cyan: "\u001b[96m",
  red: "\u001b[91m",
  dim: "\u001b[2m",
  reset: "\u001b[0m",
} as const;

export function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}

export function printYou(): void {
  process.stdout.write(`${colorize("blue", "You")}: `);
}

export function printAIPrefix(): void {
  process.stdout.write(`${colorize("yellow", "AI")}: `);
}

export function printReasoningPrefix(): void {
  process.stdout.write(`${colors.dim}${colors.cyan}[thinking] `);
}

export function printReasoningChunk(text: string): void {
  process.stdout.write(text);
}

export function printReasoningEnd(): void {
  process.stdout.write(`${colors.reset}\n`);
}

export function printChunk(text: string): void {
  process.stdout.write(text);
}

export function printNewline(): void {
  process.stdout.write("\n");
}

export function printTool(name: string, input: unknown): void {
  console.log(
    `${colorize("green", "tool")}: ${name}(${JSON.stringify(input)})`
  );
}

export function printError(message: string): void {
  console.error(`${colorize("red", "error")}: ${message}`);
}
