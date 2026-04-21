import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
