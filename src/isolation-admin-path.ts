import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

/** Check before privileged reads/execs. Every parent must resist replacement
 * by service identities; symlinks and writable administrative inputs fail shut. */
export async function assertAdministratorPath(path: string): Promise<void> {
  if (!isAbsolute(path) || normalize(path) !== path || /[\0\r\n%]/.test(path) || await realpath(path) !== path) {
    throw new Error("Administrative path must be canonical");
  }
  for (let cursor = path; ; cursor = dirname(cursor)) {
    const metadata = await lstat(cursor);
    if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0 || metadata.isSymbolicLink() ||
        (!metadata.isFile() && !metadata.isDirectory())) throw new Error("Administrative path has unsafe ownership or permissions");
    if (cursor === "/") break;
  }
}
