export interface CommandContext {
  args: string[];
}

export interface CommandResult {
  action?: "new-session";
  message?: string;
  success: boolean;
}

export interface Command {
  argumentSuggestions?: string[];
  description: string;
  execute: (context: CommandContext) => CommandResult | Promise<CommandResult>;
  name: string;
}
