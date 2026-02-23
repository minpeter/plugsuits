export const getEnvironmentContext = (): string => {
  const cwd = process.cwd();

  return `
## Environment

- **Working Directory**: ${cwd}
- **Path Resolution**: All relative paths are resolved from the working directory
- **Shell Session**: Each shell_execute runs independently (no shared session)
`;
};
