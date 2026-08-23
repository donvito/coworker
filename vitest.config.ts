import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@main": resolve("src/main"),
      "@renderer": resolve("src/renderer/src"),
      "@shared": resolve("src/shared"),
    },
  },
  plugins: [react()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
