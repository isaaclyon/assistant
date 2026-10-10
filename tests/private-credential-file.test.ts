import { beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => ({ lstat: vi.fn(), readFile: vi.fn(), realpath: vi.fn() }));
vi.mock("node:fs/promises", () => files);
import { readPrivateCredentialFile } from "../.pi/lib/private-credential-file.mjs";
const path = "/etc/bridge/credential";
const info = (directory: boolean, uid: number, mode: number, gid = process.getgid!()) => ({
  uid, gid, mode, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false,
});

describe("private credential file ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    files.realpath.mockResolvedValue(path);
    files.readFile.mockResolvedValue("synthetic-secret");
    files.lstat.mockImplementation(async (name: string) => name === path ? info(false, 0, 0o440) : info(true, 0, 0o755));
  });
  it("accepts a root-owned group-readable file beneath immutable canonical ancestry", async () => {
    await expect(readPrivateCredentialFile(path)).resolves.toBe("synthetic-secret");
  });
  it("preserves service-owned mode-0600 credentials", async () => {
    files.lstat.mockResolvedValue(info(false, process.getuid!(), 0o600));
    await expect(readPrivateCredentialFile(path)).resolves.toBe("synthetic-secret");
  });
  it("rejects writable, public, wrong-group and special-mode administrator files before reading", async () => {
    for (const metadata of [info(false, 0, 0o640), info(false, 0, 0o444), info(false, 0, 0o4440), info(false, 0, 0o440, process.getgid!() + 1)]) {
      files.lstat.mockResolvedValue(metadata);
      await expect(readPrivateCredentialFile(path)).rejects.toThrow();
    }
    expect(files.readFile).not.toHaveBeenCalled();
  });
  it("rejects replaceable ancestry and symlink aliases before reading", async () => {
    files.lstat.mockImplementation(async (name: string) => name === path ? info(false, 0, 0o440) : info(true, 0, 0o777));
    await expect(readPrivateCredentialFile(path)).rejects.toThrow();
    files.realpath.mockResolvedValue("/different/credential");
    await expect(readPrivateCredentialFile(path)).rejects.toThrow();
    expect(files.readFile).not.toHaveBeenCalled();
  });
});
