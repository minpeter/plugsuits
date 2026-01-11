export const colors = {
  blue: "\u001b[94m",
  yellow: "\u001b[93m",
  green: "\u001b[92m",
  cyan: "\u001b[96m",
  red: "\u001b[91m",
  magenta: "\u001b[95m",
  white: "\u001b[97m",
  brightBlue: "\u001b[94m",
  brightGreen: "\u001b[92m",
  brightYellow: "\u001b[93m",
  brightCyan: "\u001b[96m",
  brightMagenta: "\u001b[95m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  italic: "\u001b[3m",
  underline: "\u001b[4m",
  gray: "\u001b[90m",
  reset: "\u001b[0m",
} as const;

export function colorize(color: keyof typeof colors, text: string): string {
  return `${colors[color]}${text}${colors.reset}`;
}

export function printYou(): void {
  process.stdout.write(
    `${colors.bold}${colors.brightBlue}You${colors.reset}: `
  );
}

export function printAIPrefix(): void {
  process.stdout.write(`${colors.bold}${colors.brightCyan}AI${colors.reset}: `);
}

export function printReasoningPrefix(): void {
  process.stdout.write(`${colors.dim}${colors.italic}${colors.gray}│ `);
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
  const toolLabel = `${colors.bold}${colors.brightGreen}tool${colors.reset}`;
  const toolName = `${colors.bold}${colors.brightYellow}${name}${colors.reset}`;
  console.log(`${toolLabel} ${toolName}(${JSON.stringify(input)})`);
}

export function printError(message: string): void {
  const errorLabel = `${colors.bold}${colors.red}error${colors.reset}`;
  console.error(`${errorLabel}: ${message}`);
}
