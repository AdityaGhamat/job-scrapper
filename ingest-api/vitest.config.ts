import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    sequence: {
      // Keep suites sequential: each spins its own in-memory MongoDB.
      shuffle: false,
    },
  },
});
