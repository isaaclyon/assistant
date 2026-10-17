import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["tests/durable/**/*.test.ts","tests/memory*.test.mjs"],fileParallelism:false,testTimeout:15000,hookTimeout:15000}});
