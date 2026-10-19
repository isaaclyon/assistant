import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["prototypes/durable-baseline/*.probe.ts"],
  fileParallelism: false, testTimeout: 180_000,
} });
