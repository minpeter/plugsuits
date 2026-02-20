export interface CommandContext {
  args: string[];
}

export interface CommandResult {
  message?: string;
  success: boolean;
}

export interface Command {
  argumentSuggestions?: string[];
  description: string;
  execute: (context: CommandContext) => CommandResult | Promise<CommandResult>;
  name: string;
}
