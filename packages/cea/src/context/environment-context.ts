export const getEnvironmentContext = (): string => {
  const cwd = process.cwd();

  return `
## Environment

- **Working Directory**: ${cwd}
- **Path Resolution**: All relative paths are resolved from the working directory
- **Shell Execution Model**: Each shell_execute invocation is isolated (no retained terminal context)
`;
};
