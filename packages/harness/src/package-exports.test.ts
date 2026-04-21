import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackageJson {
  exports?: Record<string, Record<string, string>>;
}

function readPackageJson(): PackageJson {
  const packageJsonPath = fileURLToPath(
    new URL("../package.json", import.meta.url)
  );

  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
}

describe("package exports", () => {
  it("keeps source-condition coverage for documented public harness subpaths", () => {
    const packageJson = readPackageJson();
    const exportsMap = packageJson.exports ?? {};

    expect(exportsMap["./runtime"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/runtime.ts"
    );

    expect(exportsMap["./compaction"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/compaction.ts"
    );
    expect(exportsMap["./sessions"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/sessions.ts"
    );
    expect(exportsMap["./memory"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/memory.ts"
    );
    expect(exportsMap["./preferences"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/preferences.ts"
    );
    expect(exportsMap["./mcp"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/mcp.ts"
    );
    expect(exportsMap["./commands"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/commands.ts"
    );
    expect(exportsMap["./skills"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/skills.ts"
    );
    expect(exportsMap["./utils"]?.["@ai-sdk-tool/source"]).toBe(
      "./src/subpath/utils.ts"
    );
  });
});
