import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebhookJob } from "../src/jobs.js";
import { type WebhookServer, startWebhookServer } from "../src/webhook.js";

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SECRET = "0123456789abcdef0123456789abcdef";
const HMAC_SECRET = "hook-hmac-secret";

describe("startWebhookServer", () => {
  let server: WebhookServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function makeServer(jobs: WebhookJob[] = defaultJobs()) {
    const inject = vi.fn(async (_prompt: string) => {});
    server = await startWebhookServer({
      host: "127.0.0.1",
      port: 0,
      secret: SECRET,
      getJob: (id) => jobs.find((job) => job.id === id),
      inject,
      logger: silentLogger,
    });
    return {
      inject,
      post: (path: string, body: string, headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${server!.port}${path}`, {
          method: "POST",
          headers,
          body,
        }),
    };
  }

  function defaultJobs(): WebhookJob[] {
    return [
      { id: "gh-events", type: "webhook", prompt: "Summarize the event.", hmacSecret: HMAC_SECRET },
      { id: "plain", type: "webhook", prompt: "Handle it." },
    ];
  }

  it("rejects missing or wrong bearer tokens with 401", async () => {
    const { inject, post } = await makeServer();
    expect((await post("/hook/plain", "{}")).status).toBe(401);
    expect(
      (await post("/hook/plain", "{}", { authorization: `Bearer ${SECRET}x` })).status,
    ).toBe(401);
    expect(
      (await post("/hook/plain", "{}", { authorization: "Bearer short" })).status,
    ).toBe(401);
    expect(inject).not.toHaveBeenCalled();
  });

  it("accepts a correct bearer token and injects the prompt", async () => {
    const { inject, post } = await makeServer();
    const response = await post("/hook/plain", '{"a":1}', {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1));
    const prompt = inject.mock.calls[0]?.[0];
    expect(prompt).toContain("Webhook 'plain' received.");
    expect(prompt).toContain("Handle it.");
    expect(prompt).toContain("content-type: application/json");
    expect(prompt).toContain('{"a":1}');
  });

  it("accepts a valid GitHub HMAC signature and rejects an invalid one", async () => {
    const { inject, post } = await makeServer();
    const body = '{"action":"closed"}';
    const signature = `sha256=${createHmac("sha256", HMAC_SECRET).update(body).digest("hex")}`;
    expect(
      (
        await post("/hook/gh-events", body, {
          "x-hub-signature-256": signature,
          "x-github-event": "pull_request",
        })
      ).status,
    ).toBe(202);
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1));
    expect(inject.mock.calls[0]?.[0]).toContain("x-github-event: pull_request");

    expect(
      (
        await post("/hook/gh-events", `${body} `, {
          "x-hub-signature-256": signature,
        })
      ).status,
    ).toBe(401);
    // HMAC of one job never authorizes another job's hook.
    expect(
      (await post("/hook/plain", body, { "x-hub-signature-256": signature })).status,
    ).toBe(401);
  });

  it("does not reveal job existence without credentials", async () => {
    const { post } = await makeServer();
    expect((await post("/hook/nope", "{}")).status).toBe(401);
    expect(
      (await post("/hook/nope", "{}", { authorization: `Bearer ${SECRET}` })).status,
    ).toBe(404);
    expect((await post("/other/path", "{}")).status).toBe(404);
  });

  it("rejects oversize bodies with 413", async () => {
    const { inject, post } = await makeServer();
    const response = await post("/hook/plain", "x".repeat(257 * 1024), {
      authorization: `Bearer ${SECRET}`,
    });
    expect(response.status).toBe(413);
    expect(inject).not.toHaveBeenCalled();
  });

  it("truncates large bodies in the injected prompt", async () => {
    const { inject, post } = await makeServer();
    const body = "y".repeat(64 * 1024);
    expect(
      (await post("/hook/plain", body, { authorization: `Bearer ${SECRET}` })).status,
    ).toBe(202);
    await vi.waitFor(() => expect(inject).toHaveBeenCalledTimes(1));
    const prompt = inject.mock.calls[0]?.[0] ?? "";
    expect(prompt.length).toBeLessThan(20 * 1024);
    expect(prompt.length).toBeGreaterThan(16 * 1024);
  });
});
