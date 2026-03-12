import { readFileSync } from "node:fs";

export function readTextAsset(relativePath: string, baseUrl: string): string {
  return readFileSync(new URL(relativePath, baseUrl), "utf8");
}
