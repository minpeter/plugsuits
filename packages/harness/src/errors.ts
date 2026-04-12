export enum AgentErrorCode {
  CONTEXT_OVERFLOW = "CONTEXT_OVERFLOW",
  NO_OUTPUT = "NO_OUTPUT",
  TOOL_FAILURE = "TOOL_FAILURE",
  TIMEOUT = "TIMEOUT",
  MAX_ITERATIONS = "MAX_ITERATIONS",
  MAX_TOOL_CALLS = "MAX_TOOL_CALLS",
  REPEATED_TOOL_CALL = "REPEATED_TOOL_CALL",
}

export class AgentError extends Error {
  code: AgentErrorCode;
  override cause?: Error;

  constructor(code: AgentErrorCode, message: string, cause?: Error) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.cause = cause;
    Object.setPrototypeOf(this, AgentError.prototype);
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof AgentError;
}
