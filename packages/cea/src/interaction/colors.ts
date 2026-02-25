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
