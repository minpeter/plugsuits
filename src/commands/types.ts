export interface CommandContext {
  args: string[];
}

export interface CommandResult {
  success: boolean;
  message?: string;
}

export interface Command {
  name: string;
  description: string;
  execute: (context: CommandContext) => CommandResult | Promise<CommandResult>;
  argumentSuggestions?: string[];
}
