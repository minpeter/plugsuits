export const getEnvironmentContext = (): string => {
  const cwd = process.cwd();
  const user = process.env.USER || process.env.USERNAME || "unknown";
  const home = process.env.HOME || process.env.USERPROFILE || "unknown";
  const shell = process.env.SHELL || process.env.COMSPEC || "unknown";

  return `

## CRITICAL: File Path Rules (READ CAREFULLY)

You are running in: ${cwd}

### ABSOLUTE PATH REQUIREMENT
When the task mentions a path starting with "/" (like "/app/file.txt"):
- You MUST use that EXACT absolute path
- DO NOT convert it to a relative path
- DO NOT remove the leading "/"

Examples:
- Task says "create /app/out.html" → use path="/app/out.html" (NOT "out.html")
- Task says "read /app/filter.py" → use path="/app/filter.py" (NOT "filter.py")
- Task says "file.txt" (no leading /) → use path="file.txt" (relative is OK)

### Why This Matters
- Relative paths resolve to ${cwd}/filename
- Absolute paths like /app/filename go to a completely different location
- Using the wrong path type will cause the task to fail

Current Environment:
- Working Directory: ${cwd}
- User: ${user}
- Home: ${home}
- Shell: ${shell}`;
};
