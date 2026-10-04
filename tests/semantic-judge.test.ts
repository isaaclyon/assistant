import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createTypeSafeJudge, parseJudgeResponse, SEMANTIC_JUDGE_MODEL } from "../src/semantic-judge.js";

const request = {
  state: { items: [{ id: "t1", subject: "Re: Move-out" }] },
  questions: {
    item_0: {
      type: "noul" as const,
      instructions: "Is `items[0]` about the move-out inspection?",
      criteria: { true: "It is", false: "It is not" },
    },
  },
};

async function keyFile(mode = 0o600): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "typesafe-key-")), "key");
  await writeFile(path, "ts-secret-key\n", { mode });
  await chmod(path, mode);
  return path;
}

function answer(noul: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ model: SEMANTIC_JUDGE_MODEL, answers: { item_0: { type: "noul", noul } } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("createTypeSafeJudge", () => {
  it("preserves reported input usage and ignores missing or malformed accounting", () => {
    const body = { model: SEMANTIC_JUDGE_MODEL, answers: { item_0: { type: "noul", noul: 0.9 } } };
    for (const inputTokens of [0, 4096]) {
      expect(parseJudgeResponse({ ...body, usage: { input_tokens: inputTokens } }, ["item_0"]).inputTokens)
        .toBe(inputTokens);
    }
    for (const usage of [undefined, null, {}, { input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: "42" }]) {
      expect(parseJudgeResponse({ ...body, usage }, ["item_0"]).inputTokens).toBeUndefined();
    }
  });

  it("posts the pinned model with a just-in-time bearer key and returns P(yes)", async () => {
    const fetcher = vi.fn(async () => answer(0.93));
    const judge = createTypeSafeJudge({
      env: { PI_TELEGRAM_TYPESAFE_API_KEY_FILE: await keyFile() },
      fetcher,
    });

    await expect(judge(request)).resolves.toEqual({
      model: SEMANTIC_JUDGE_MODEL,
      probabilities: { item_0: 0.93 },
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ts-secret-key");
    expect(JSON.parse(init.body as string)).toEqual({ model: SEMANTIC_JUDGE_MODEL, ...request });
  });

  it("retries overload and rate limits with backoff, but not other errors", async () => {
    const sleep = vi.fn(async () => {});
    const env = { PI_TELEGRAM_TYPESAFE_API_KEY_FILE: await keyFile() };
    const retrying = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 529 }))
      .mockRejectedValueOnce(new Error("socket reset"))
      .mockResolvedValueOnce(answer(0.1));
    await expect(createTypeSafeJudge({ env, fetcher: retrying, sleep })(request)).resolves.toMatchObject({
      probabilities: { item_0: 0.1 },
    });
    expect(retrying).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);

    const unauthorized = vi.fn(async () => new Response("", { status: 401 }));
    await expect(createTypeSafeJudge({ env, fetcher: unauthorized, sleep })(request)).rejects.toThrow(
      /HTTP 401/,
    );
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });

  it("fails closed on missing or unsafe keys and malformed answers without leaking the key", async () => {
    const fetcher = vi.fn(async () => answer(0.5));
    await expect(createTypeSafeJudge({ env: {}, fetcher })(request)).rejects.toThrow(/not configured/);
    await expect(
      createTypeSafeJudge({ env: { PI_TELEGRAM_TYPESAFE_API_KEY_FILE: await keyFile(0o644) }, fetcher })(
        request,
      ),
    ).rejects.toThrow(/unavailable or unsafe/);
    expect(fetcher).not.toHaveBeenCalled();

    const env = { PI_TELEGRAM_TYPESAFE_API_KEY_FILE: await keyFile() };
    for (const bad of [1.5, "0.9", null]) {
      const error = await createTypeSafeJudge({ env, fetcher: async () => answer(bad) })(request).catch(
        (caught: unknown) => caught as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/invalid response/);
      expect((error as Error).message).not.toContain("ts-secret-key");
    }
  });
});
