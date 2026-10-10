import { readFile, stat } from "node:fs/promises";
import { assertAdministratorPath } from "./isolation-admin-path.js";
import { auditIsolationProcess, type IsolationAuditPolicy } from "./isolation-audit.js";

try {
  const [filename, namespace] = process.argv.slice(2);
  if (!filename || process.argv.length !== 4 || !/^pi-[a-z0-9-]{1,24}$/.test(namespace ?? "")) throw new Error();
  await assertAdministratorPath(filename);
  const policy: IsolationAuditPolicy = JSON.parse(await readFile(filename, "utf8"));
  const failures = await auditIsolationProcess(policy);
  const [actual, expected] = await Promise.all([stat("/proc/self/ns/net"), stat(`/run/netns/${namespace}`)]);
  if (actual.ino !== expected.ino || actual.dev !== expected.dev) failures.push("network_namespace_mismatch");
  if (failures.length) throw new Error();
} catch {
  process.stderr.write("Runtime isolation preflight failed; service startup refused.\n");
  process.exitCode = 1;
}
