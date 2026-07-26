import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseSessionJsonlFile } from "../src/session-jsonl-parser.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sessionFile(lines: unknown[], trailingNewline = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "session-parser-test-"));
  roots.push(root);
  const path = join(root, "2026-07-25_session-1.jsonl");
  const content = lines.map((line) => JSON.stringify(line)).join("\n") + (trailingNewline ? "\n" : "");
  await writeFile(path, content);
  return path;
}

const header = {
  type: "session",
  version: 3,
  id: "session-1",
  timestamp: "2026-07-25T12:00:00.000Z",
  cwd: "/private/project",
};

function message(id: string, role: string, content: unknown, timestamp = "2026-07-25T12:01:00.000Z") {
  return { type: "message", id, parentId: null, timestamp, message: { role, content } };
}

describe("parseSessionJsonlFile", () => {
  it("normalizes user and assistant text with stable provenance and opt-in cwd", async () => {
    const path = await sessionFile([
      header,
      message("entry-user", "user", "hello"),
      message("entry-assistant", "assistant", [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ]);

    const result = await parseSessionJsonlFile({
      path,
      instanceId: "isaac",
      principal: "isaac",
      includeSafeCwd: true,
    });

    expect(result.documents).toEqual([
      {
        instanceId: "isaac",
        principal: "isaac",
        sessionId: "session-1",
        entryId: "entry-user",
        timestamp: "2026-07-25T12:01:00.000Z",
        role: "user",
        cwd: "/private/project",
        source: { path, byteOffset: expect.any(Number) },
        text: "hello",
        truncated: false,
      },
      {
        instanceId: "isaac",
        principal: "isaac",
        sessionId: "session-1",
        entryId: "entry-assistant",
        timestamp: "2026-07-25T12:01:00.000Z",
        role: "assistant",
        cwd: "/private/project",
        source: { path, byteOffset: expect.any(Number) },
        text: "first\nsecond",
        truncated: false,
      },
    ]);
    expect(result.findings).toEqual([]);
    expect(result.completion).toBe("clean-eof");
    expect(result.nextOffset).toBe(result.file.size);
  });

  it("allowlists safe text and excludes private or binary block shapes", async () => {
    const path = await sessionFile([
      header,
      message("entry-assistant", "assistant", [
        { type: "thinking", thinking: "private chain" },
        { type: "toolCall", name: "shell", arguments: { token: "secret-token" } },
        { type: "text", text: "safe answer" },
        { type: "image", data: "binary-image" },
        { type: "text", text: "data:image/png;base64,c2VjcmV0" },
        { type: "text", text: "VGhpcyBpcyBhIHZlcnkgbG9uZyBiYXNlNjQgcGF5bG9hZA==" },
        { type: "text", text: "api_key=secret-value" },
      ]),
      message("entry-tool", "toolResult", [
        { type: "text", text: "bounded tool summary" },
        { type: "image", data: "excluded" },
      ]),
    ]);

    const result = await parseSessionJsonlFile({
      path,
      instanceId: "household",
      principal: "household",
    });

    expect(result.documents.map(({ entryId, role, text }) => ({ entryId, role, text }))).toEqual([
      { entryId: "entry-assistant", role: "assistant", text: "safe answer" },
      { entryId: "entry-tool", role: "toolResult", text: "bounded tool summary" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private chain");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("secret-value");
    expect(JSON.stringify(result)).not.toContain("binary-image");
    expect(result.documents[0]).not.toHaveProperty("cwd");
  });

  it("reports malformed and identity failures with deterministic content-free codes", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-parser-test-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    await writeFile(
      path,
      [
        JSON.stringify(header),
        '{"type":"message","id":"malformed-secret","message":{"content":"password=hunter2"}',
        JSON.stringify(message("", "user", "missing id")),
        JSON.stringify({ ...message("missing-time", "user", "missing timestamp"), timestamp: null }),
        JSON.stringify(message("duplicate", "user", "first")),
        JSON.stringify(message("duplicate", "assistant", "second")),
        "",
      ].join("\n"),
    );

    const result = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });

    expect(result.findings.map((finding) => finding.code)).toEqual([
      "MALFORMED_JSON",
      "MISSING_ENTRY_ID",
      "INVALID_ENTRY_TIMESTAMP",
      "DUPLICATE_ENTRY_ID",
    ]);
    expect(JSON.stringify(result.findings)).not.toContain("hunter2");
    expect(result.documents.map((document) => document.text)).toEqual(["first"]);
  });

  it("returns an incomplete final line for retry without a corruption finding", async () => {
    const path = await sessionFile([header, message("complete", "user", "one")]);
    await appendFile(path, '{"type":"message","id":"pending"');

    const first = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });

    expect(first.completion).toBe("incomplete-tail");
    expect(first.findings).toEqual([]);
    expect(first.documents.map((document) => document.entryId)).toEqual(["complete"]);
    expect(first.nextOffset).toBeLessThan(first.file.size);

    await appendFile(
      path,
      ',"parentId":null,"timestamp":"2026-07-25T12:02:00.000Z","message":{"role":"user","content":"two"}}\n',
    );
    const retried = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });
    expect(retried.completion).toBe("clean-eof");
    expect(retried.documents.map((document) => document.entryId)).toEqual(["complete", "pending"]);
  });

  it("rejects an invalid session header without exposing its content", async () => {
    const path = await sessionFile([{ type: "session", id: "", timestamp: "bad", cwd: "secret" }]);

    const result = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });

    expect(result.documents).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["INVALID_SESSION_HEADER"]);
    expect(JSON.stringify(result.findings)).not.toContain("secret");
  });

  it("enforces block, entry, file, and total-output byte limits", async () => {
    const path = await sessionFile([
      header,
      message("limited", "assistant", [
        { type: "text", text: "abcdefgh" },
        { type: "text", text: "ijklmnop" },
      ]),
      message("not-output", "user", "qrstuvwx"),
      message("beyond-file", "user", "yz"),
    ]);

    const content = await import("node:fs/promises").then(({ readFile }) => readFile(path));
    const thirdLineEnd = content.indexOf(10, content.indexOf(10, content.indexOf(10) + 1) + 1) + 1;
    const result = await parseSessionJsonlFile({
      path,
      instanceId: "i",
      principal: "p",
      limits: {
        maxBlockBytes: 5,
        maxEntryBytes: 9,
        maxFileBytes: thirdLineEnd,
        maxOutputBytes: 9,
      },
    });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({ entryId: "limited", text: "abcde\nijk", truncated: true });
    expect(Buffer.byteLength(result.documents[0]?.text ?? "")).toBeLessThanOrEqual(9);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "BLOCK_TRUNCATED",
      "BLOCK_TRUNCATED",
      "ENTRY_TRUNCATED",
      "BLOCK_TRUNCATED",
      "TOTAL_OUTPUT_LIMIT",
      "FILE_LIMIT",
    ]);
    expect(result.nextOffset).toBe(thirdLineEnd);
  });

  it("resumes at a safe byte offset and returns only appended documents", async () => {
    const path = await sessionFile([header, message("one", "user", "first")]);
    const first = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });
    await appendFile(
      path,
      `${JSON.stringify(message("two", "assistant", [{ type: "text", text: "second" }]))}\n`,
    );

    const resumed = await parseSessionJsonlFile({
      path,
      instanceId: "i",
      principal: "p",
      offset: first.nextOffset,
      previousFile: first.file,
    });

    expect(resumed.documents.map((document) => document.entryId)).toEqual(["two"]);
    expect(resumed.documents[0]?.source.byteOffset).toBe(first.nextOffset);
    expect(resumed.completion).toBe("clean-eof");
    expect(resumed.nextOffset).toBe(resumed.file.size);
  });

  it("distinguishes truncation and replacement from append-only growth", async () => {
    const path = await sessionFile([header, message("one", "user", "first")]);
    const first = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });

    await writeFile(path, `${JSON.stringify(header)}\n`);
    const truncated = await parseSessionJsonlFile({
      path,
      instanceId: "i",
      principal: "p",
      offset: first.nextOffset,
      previousFile: first.file,
    });
    expect(truncated.completion).toBe("file-truncated");
    expect(truncated.documents).toEqual([]);
    expect(truncated.nextOffset).toBe(0);

    await rm(path);
    await writeFile(path, `${JSON.stringify(header)}\n`);
    const replaced = await parseSessionJsonlFile({
      path,
      instanceId: "i",
      principal: "p",
      previousFile: first.file,
    });
    expect(replaced.completion).toBe("file-replaced");
    expect(replaced.documents).toEqual([]);
    expect(replaced.nextOffset).toBe(0);
  });

  it("treats a scan cap inside a line as a file limit, not an incomplete append", async () => {
    const path = await sessionFile([header, message("large", "user", "visible but long")]);
    const headerBytes = Buffer.byteLength(`${JSON.stringify(header)}\n`);

    const result = await parseSessionJsonlFile({
      path,
      instanceId: "i",
      principal: "p",
      limits: { maxFileBytes: headerBytes + 12 },
    });

    expect(result.completion).toBe("clean-eof");
    expect(result.documents).toEqual([]);
    expect(result.findings.map((finding) => finding.code)).toEqual(["FILE_LIMIT"]);
    expect(result.nextOffset).toBe(headerBytes);
  });

  it("excludes JSON-shaped credentials and private-key text without echoing them", async () => {
    const path = await sessionFile([
      header,
      message("secrets", "toolResult", [
        { type: "text", text: '{"password":"do-not-copy"}' },
        { type: "text", text: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
        { type: "text", text: "safe diagnostic" },
      ]),
    ]);

    const result = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });

    expect(result.documents.map((document) => document.text)).toEqual(["safe diagnostic"]);
    expect(JSON.stringify(result)).not.toContain("do-not-copy");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("does not emit an unterminated record and keeps offsets correct across blank lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-parser-test-"));
    roots.push(root);
    const path = join(root, "session.jsonl");
    const firstLine = `${JSON.stringify(header)}\n`;
    const completeLine = `${JSON.stringify(message("complete", "user", "one"))}\n`;
    const pendingLine = JSON.stringify(message("pending", "assistant", "two"));
    await writeFile(path, `${firstLine}\n${completeLine}${pendingLine}`);

    const result = await parseSessionJsonlFile({ path, instanceId: "i", principal: "p" });

    expect(result.completion).toBe("incomplete-tail");
    expect(result.documents.map((document) => document.entryId)).toEqual(["complete"]);
    expect(result.documents[0]?.source.byteOffset).toBe(Buffer.byteLength(firstLine) + 1);
    expect(result.nextOffset).toBe(Buffer.byteLength(firstLine) + 1 + Buffer.byteLength(completeLine));
  });

  it("validates only the header before resuming and reads entry data in bounded chunks", async () => {
    const path = await sessionFile([
      header,
      message("earlier", "user", "must not be reread"),
      message("resume", "assistant", "chunked unicode 🦬"),
    ]);
    const fileBytes = await readFile(path);
    const headerEnd = fileBytes.indexOf(10) + 1;
    const resumeOffset = fileBytes.indexOf(10, headerEnd) + 1;
    const reads: Array<{ position: number; length: number }> = [];

    const result = await parseSessionJsonlFile({
      path,
      instanceId: "i",
      principal: "p",
      offset: resumeOffset,
      chunkBytes: 7,
      readChunk: async (position, length) => {
        reads.push({ position, length });
        return fileBytes.subarray(position, Math.min(position + length, fileBytes.length));
      },
    });

    expect(result.documents.map((document) => document.entryId)).toEqual(["resume"]);
    expect(result.documents[0]?.text).toBe("chunked unicode 🦬");
    expect(reads.every((read) => read.length <= 7)).toBe(true);
    expect(reads.some((read) => read.position < headerEnd && read.length > 1)).toBe(true);
    expect(reads.some((read) => read.position === resumeOffset)).toBe(true);
    const headerCompletingRead = reads.findIndex(
      (read) => read.position < headerEnd && read.position + read.length >= headerEnd,
    );
    expect(headerCompletingRead).toBeGreaterThanOrEqual(0);
    expect(reads.slice(headerCompletingRead + 1).every((read) => read.position >= resumeOffset)).toBe(
      true,
    );
  });

  it("rejects an appended entry whose ID was seen before the resume offset", async () => {
    const path = await sessionFile([
      header,
      message("existing", "user", "original"),
      message("existing", "assistant", "duplicate append"),
    ]);
    const fileBytes = await readFile(path);
    const headerEnd = fileBytes.indexOf(10) + 1;
    const resumeOffset = fileBytes.indexOf(10, headerEnd) + 1;

    const result = await parseSessionJsonlFile({
      path,
      instanceId: "i",
      principal: "p",
      offset: resumeOffset,
      seenEntryIds: new Set(["existing"]),
    });

    expect(result.documents).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "DUPLICATE_ENTRY_ID", entryId: "existing" }),
    ]);
  });
});
