import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@main": resolve("src/main"),
      "@renderer": resolve("src/renderer/src"),
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    environment: "node",
    include: ["evals/**/*.eval.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    reporters: ["vitest-evals/reporter"],
    env: {
      VITEST_EVALS_REPLAY_MODE:
        process.env.VITEST_EVALS_REPLAY_MODE ?? "auto",
      VITEST_EVALS_REPLAY_DIR: ".vitest-evals/recordings",
    },
  },
});
