export const getEnvironmentContext = (): string => {
  const cwd = process.cwd();

  return `
## Environment
- Working Directory: ${cwd}
`;
};
