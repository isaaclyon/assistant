#!/usr/bin/env node
import { pathToFileURL } from "node:url";

// The deployed release owns the compiled domain implementation and its parser.
// Keep the established skill command stable without duplicating scheduler rules.
const implementation = () => import("../../../../dist/src/jobs-cli.js");
export async function resolveCoordinatorStateDir(env) {
  return (await implementation()).resolveCoordinatorStateDir(env);
}
export async function applyJobsRequest(input, options) {
  return (await implementation()).applyJobsRequest(input, options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await (await implementation()).runJobsCli();
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "Jobs helper is unavailable; build the release before use." }) + "\n");
    process.exitCode = 1;
  }
}
