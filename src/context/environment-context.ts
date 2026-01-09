export const getEnvironmentContext = (): string => {
  const cwd = process.cwd();

  return `
## Environment

- **Working Directory**: ${cwd}
- **Path Resolution**: All relative paths are resolved from the working directory
- **Shell Session**: Persistent across shell_execute and shell_interact calls
`;
};
