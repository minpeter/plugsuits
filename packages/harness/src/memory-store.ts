import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MemoryStore {
  isEmpty(): Promise<boolean>;
  read(): Promise<string>;
  write(content: string): Promise<void>;
}

export class InMemoryStore implements MemoryStore {
  private content = "";

  read(): Promise<string> {
    return Promise.resolve(this.content);
  }

  write(content: string): Promise<void> {
    this.content = content;
    return Promise.resolve();
  }

  isEmpty(): Promise<boolean> {
    return Promise.resolve(this.content.trim().length === 0);
  }
}

export class FileMemoryStore implements MemoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async read(): Promise<string> {
    try {
      return await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return "";
      }
      throw error;
    }
  }

  async write(content: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, content, "utf8");
  }

  async isEmpty(): Promise<boolean> {
    const content = await this.read();
    return content.trim().length === 0;
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
