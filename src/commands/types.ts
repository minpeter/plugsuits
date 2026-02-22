export interface CommandContext {
  args: string[];
}

export interface CommandResult {
  action?: "new-session";
  message?: string;
  success: boolean;
}

export interface Command {
  aliases?: string[];
  argumentSuggestions?: string[];
  description: string;
  displayName?: string;
  execute: (context: CommandContext) => CommandResult | Promise<CommandResult>;
  name: string;
}
