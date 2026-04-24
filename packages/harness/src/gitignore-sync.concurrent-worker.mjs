import { ensureGitignoreEntry } from "./gitignore-sync.ts";

const [, , gitignorePath, entry] = process.argv;
if (!(gitignorePath && entry)) {
  process.exit(2);
}

ensureGitignoreEntry(gitignorePath, entry);
process.exit(0);
