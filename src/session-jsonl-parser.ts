import { open, stat } from "node:fs/promises";

export interface SessionParserLimits {
  maxBlockBytes: number;
  maxEntryBytes: number;
  maxFileBytes: number;
  maxOutputBytes: number;
}

export interface SessionFileState {
  device: number;
  inode: number;
  size: number;
}

export interface SessionDocument {
  instanceId: string;
  principal: string;
  sessionId: string;
  entryId: string;
  timestamp: string;
  role: "user" | "assistant" | "toolResult";
  cwd?: string;
  source: { path: string; byteOffset: number };
  text: string;
  truncated: boolean;
}

export interface SessionParserFinding {
  code: string;
  path: string;
  sessionId?: string;
  entryId?: string;
  byteOffset?: number;
}

export interface ParseSessionJsonlOptions {
  path: string;
  instanceId: string;
  principal: string;
  includeSafeCwd?: boolean;
  offset?: number;
  previousFile?: SessionFileState;
  seenEntryIds?: ReadonlySet<string>;
  limits?: Partial<SessionParserLimits>;
  chunkBytes?: number;
  readChunk?: (position: number, length: number) => Promise<Uint8Array>;
}

export interface ParseSessionJsonlResult {
  documents: SessionDocument[];
  findings: SessionParserFinding[];
  completion: "clean-eof" | "incomplete-tail" | "file-truncated" | "file-replaced";
  nextOffset: number;
  file: SessionFileState;
}

const DEFAULT_LIMITS: SessionParserLimits = {
  maxBlockBytes: 64 * 1024,
  maxEntryBytes: 256 * 1024,
  maxFileBytes: 64 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
};
const MAX_JSONL_LINE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

const SECRET_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)["']?\s*[:=]/i;
const BASE64_PAYLOAD = /^(?:[A-Za-z0-9+/]{4}){8,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function safeText(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.toLowerCase().startsWith("data:") &&
    !BASE64_PAYLOAD.test(trimmed) &&
    !SECRET_ASSIGNMENT.test(trimmed) &&
    !PRIVATE_KEY.test(trimmed)
  );
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  return { text: bytes.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, ""), truncated: true };
}

function extractText(content: unknown, maxBlockBytes: number): Array<{ text: string; truncated: boolean }> {
  if (typeof content === "string") {
    return safeText(content) ? [truncateUtf8(content, maxBlockBytes)] : [];
  }
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isRecord(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    safeText(block.text)
      ? [truncateUtf8(block.text, maxBlockBytes)]
      : [],
  );
}

interface LineRead {
  bytes: Buffer;
  nextOffset: number;
  terminated: boolean;
  overflow: boolean;
}

async function readLineAt(
  readChunk: (position: number, length: number) => Promise<Uint8Array>,
  startOffset: number,
  endOffset: number,
  chunkBytes: number,
  maxRetainedBytes: number,
): Promise<LineRead> {
  const parts: Buffer[] = [];
  let retainedBytes = 0;
  let position = startOffset;
  let overflow = false;
  while (position < endOffset) {
    const requested = Math.min(chunkBytes, endOffset - position);
    const chunk = Buffer.from(await readChunk(position, requested));
    if (chunk.length === 0) break;
    const newline = chunk.indexOf(0x0a);
    const contentBytes = newline === -1 ? chunk.length : newline;
    const retain = Math.min(contentBytes, Math.max(0, maxRetainedBytes - retainedBytes));
    if (retain > 0) {
      parts.push(chunk.subarray(0, retain));
      retainedBytes += retain;
    }
    if (retain < contentBytes) overflow = true;
    if (newline !== -1) {
      return {
        bytes: Buffer.concat(parts, retainedBytes),
        nextOffset: position + newline + 1,
        terminated: true,
        overflow,
      };
    }
    position += chunk.length;
    if (chunk.length < requested) break;
  }
  return {
    bytes: Buffer.concat(parts, retainedBytes),
    nextOffset: position,
    terminated: false,
    overflow,
  };
}

export async function parseSessionJsonlFile(
  options: ParseSessionJsonlOptions,
): Promise<ParseSessionJsonlResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const chunkBytes = Math.max(1, Math.min(options.chunkBytes ?? 64 * 1024, limits.maxFileBytes));
  const metadata = await stat(options.path);
  const file = { device: metadata.dev, inode: metadata.ino, size: metadata.size };
  if (
    options.previousFile &&
    (options.previousFile.device !== file.device || options.previousFile.inode !== file.inode)
  ) {
    return {
      documents: [],
      findings: [{ code: "FILE_REPLACED", path: options.path }],
      completion: "file-replaced",
      nextOffset: 0,
      file,
    };
  }
  if (
    options.previousFile &&
    (file.size < options.previousFile.size || file.size < (options.offset ?? 0))
  ) {
    return {
      documents: [],
      findings: [{ code: "FILE_TRUNCATED", path: options.path }],
      completion: "file-truncated",
      nextOffset: 0,
      file,
    };
  }

  const handle = options.readChunk ? undefined : await open(options.path, "r");
  const readChunk =
    options.readChunk ??
    (async (position: number, length: number): Promise<Uint8Array> => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle!.read(buffer, 0, length, position);
      return buffer.subarray(0, bytesRead);
    });
  try {
    const header = await readLineAt(
      readChunk,
      0,
      Math.min(file.size, MAX_JSONL_LINE_BYTES + 1),
      chunkBytes,
      MAX_JSONL_LINE_BYTES,
    );
    let parsedHeader: unknown;
    try {
      parsedHeader =
        header.terminated && !header.overflow
          ? JSON.parse(header.bytes.toString("utf8"))
          : undefined;
    } catch {
      parsedHeader = undefined;
    }
    if (
      !isRecord(parsedHeader) ||
      parsedHeader.type !== "session" ||
      typeof parsedHeader.id !== "string" ||
      parsedHeader.id.length === 0 ||
      !canonicalTimestamp(parsedHeader.timestamp)
    ) {
      return {
        documents: [],
        findings: [{ code: "INVALID_SESSION_HEADER", path: options.path, byteOffset: 0 }],
        completion: header.terminated ? "clean-eof" : "incomplete-tail",
        nextOffset: 0,
        file,
      };
    }

    const scanStart = Math.max(options.offset ?? header.nextOffset, header.nextOffset);
    const scanEnd = Math.min(
      file.size,
      options.offset === undefined ? limits.maxFileBytes : scanStart + limits.maxFileBytes,
    );
    const documents: SessionDocument[] = [];
    const findings: SessionParserFinding[] = [];
    const seenIds = new Set(options.seenEntryIds);
    let outputBytes = 0;
    let byteOffset = scanStart;

    while (byteOffset < scanEnd) {
      const lineOffset = byteOffset;
      const line = await readLineAt(
        readChunk,
        lineOffset,
        scanEnd,
        chunkBytes,
        MAX_JSONL_LINE_BYTES,
      );
      if (!line.terminated) {
        if (scanEnd < file.size) {
          findings.push({
            code: "FILE_LIMIT",
            path: options.path,
            sessionId: parsedHeader.id,
            byteOffset: lineOffset,
          });
          return {
            documents,
            findings,
            completion: "clean-eof",
            nextOffset: lineOffset,
            file,
          };
        }
        return {
          documents,
          findings,
          completion: "incomplete-tail",
          nextOffset: lineOffset,
          file,
        };
      }
      byteOffset = line.nextOffset;
      if (line.bytes.length === 0) continue;
      if (line.overflow) {
        findings.push({
          code: "ENTRY_LIMIT",
          path: options.path,
          sessionId: parsedHeader.id,
          byteOffset: lineOffset,
        });
        continue;
      }

      let entry: unknown;
      try {
        entry = JSON.parse(line.bytes.toString("utf8"));
      } catch {
        findings.push({
          code: "MALFORMED_JSON",
          path: options.path,
          sessionId: parsedHeader.id,
          byteOffset: lineOffset,
        });
        continue;
      }
      if (isRecord(entry) && entry.type === "message") {
        if (typeof entry.id !== "string" || entry.id.length === 0) {
          findings.push({
            code: "MISSING_ENTRY_ID",
            path: options.path,
            sessionId: parsedHeader.id,
            byteOffset: lineOffset,
          });
          continue;
        }
        if (!canonicalTimestamp(entry.timestamp)) {
          findings.push({
            code: "INVALID_ENTRY_TIMESTAMP",
            path: options.path,
            sessionId: parsedHeader.id,
            entryId: entry.id,
            byteOffset: lineOffset,
          });
          continue;
        }
        if (seenIds.has(entry.id)) {
          findings.push({
            code: "DUPLICATE_ENTRY_ID",
            path: options.path,
            sessionId: parsedHeader.id,
            entryId: entry.id,
            byteOffset: lineOffset,
          });
          continue;
        }
        seenIds.add(entry.id);
      }
      if (
        !isRecord(entry) ||
        entry.type !== "message" ||
        typeof entry.id !== "string" ||
        !canonicalTimestamp(entry.timestamp) ||
        !isRecord(entry.message) ||
        (entry.message.role !== "user" &&
          entry.message.role !== "assistant" &&
          entry.message.role !== "toolResult")
      ) {
        continue;
      }

      const blocks = extractText(entry.message.content, limits.maxBlockBytes);
      for (const block of blocks) {
        if (block.truncated) {
          findings.push({
            code: "BLOCK_TRUNCATED",
            path: options.path,
            sessionId: parsedHeader.id,
            entryId: entry.id,
            byteOffset: lineOffset,
          });
        }
      }
      const limitedEntry = truncateUtf8(
        blocks.map((block) => block.text).join("\n"),
        limits.maxEntryBytes,
      );
      if (limitedEntry.truncated) {
        findings.push({
          code: "ENTRY_TRUNCATED",
          path: options.path,
          sessionId: parsedHeader.id,
          entryId: entry.id,
          byteOffset: lineOffset,
        });
      }
      if (!limitedEntry.text) continue;
      const textBytes = Buffer.byteLength(limitedEntry.text);
      if (outputBytes + textBytes > limits.maxOutputBytes) {
        findings.push({
          code: "TOTAL_OUTPUT_LIMIT",
          path: options.path,
          sessionId: parsedHeader.id,
          entryId: entry.id,
          byteOffset: lineOffset,
        });
        continue;
      }
      documents.push({
        instanceId: options.instanceId,
        principal: options.principal,
        sessionId: parsedHeader.id,
        entryId: entry.id,
        timestamp: entry.timestamp,
        role: entry.message.role,
        ...(options.includeSafeCwd && typeof parsedHeader.cwd === "string"
          ? { cwd: parsedHeader.cwd }
          : {}),
        source: { path: options.path, byteOffset: lineOffset },
        text: limitedEntry.text,
        truncated: blocks.some((block) => block.truncated) || limitedEntry.truncated,
      });
      outputBytes += textBytes;
    }

    if (scanEnd < file.size) {
      findings.push({
        code: "FILE_LIMIT",
        path: options.path,
        sessionId: parsedHeader.id,
        byteOffset: scanEnd,
      });
    }
    return {
      documents,
      findings,
      completion: "clean-eof",
      nextOffset: scanEnd,
      file,
    };
  } finally {
    await handle?.close();
  }
}
