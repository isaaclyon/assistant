import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["prototypes/durable-c1/**/*.test.ts"],fileParallelism:false,testTimeout:15000,hookTimeout:15000}});
