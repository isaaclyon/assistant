import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

/** Personal files, or administrator-provisioned files readable by this service's group. */
export async function readPrivateCredentialFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error("Credential path must be a regular file");
  const mode = metadata.mode & 0o7777;
  if (mode === 0o600 && metadata.uid === process.getuid?.()) return readFile(path, "utf8");
  if (mode !== 0o440 || metadata.uid !== 0 || metadata.gid !== process.getgid?.() ||
      !isAbsolute(path) || normalize(path) !== path || await realpath(path) !== path) {
    throw new Error("Credential file has unsafe ownership or permissions");
  }
  for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
    const parent = await lstat(cursor);
    if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) || parent.isSymbolicLink()) {
      throw new Error("Administrative credential ancestry is unsafe");
    }
    if (cursor === "/") break;
  }
  return readFile(path, "utf8");
}
