import { assertRuntimeReady, readRuntimeMetadata } from "./runtime-metadata.js";

const [path, instanceId, releaseSha, pidRaw] = process.argv.slice(2);
const pid = Number(pidRaw);
if (!path || !instanceId || !releaseSha || !Number.isSafeInteger(pid) || pid <= 0) {
  throw new Error(
    "Usage: readiness-check <runtime-metadata-path> <instance-id> <release-sha> <pid>",
  );
}
assertRuntimeReady(await readRuntimeMetadata(path), {
  instanceId,
  releaseSha,
  pid,
});
