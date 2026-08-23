import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          "runtime/coworker-worker": resolve("src/main/runtime/coworker-worker.ts"),
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
        "@main": resolve("src/main"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          entryFileNames: "[name].cjs",
          format: "cjs",
        },
      },
    },
    resolve: {
      alias: {
        "@shared": resolve("src/shared"),
      },
    },
  },
  renderer: {
    define: {
      "process.env.COPILOTKIT_TELEMETRY_DISABLED": JSON.stringify("true"),
      "process.env.DO_NOT_TRACK": JSON.stringify("true"),
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
        "@shared": resolve("src/shared"),
        "@segment/analytics-node": resolve(
          "src/renderer/src/shims/segment-analytics-node.ts",
        ),
      },
    },
    plugins: [react()],
  },
});
