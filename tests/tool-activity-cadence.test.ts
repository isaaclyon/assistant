import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());

it("coalesces active status changes into one-second edits and cancels pending edits on finish", async () => {
  const specifier = new URL(
    "../node_modules/@llblab/pi-telegram/lib/tool-activity.ts", import.meta.url,
  ).href;
  const { createTelegramToolActivityRuntime } = await import(specifier);
  vi.useFakeTimers();
  const sendMessage = vi.fn(async () => ({ message_id: 42 }));
  const editMessageText = vi.fn(async (_body: { text: string }) => undefined);
  const deleteMessage = vi.fn(async () => undefined);
  const runtime = createTelegramToolActivityRuntime({
    isEnabled: () => true,
    getActiveTurn: () => ({ chatId: 123 }),
    sendMessage,
    editMessageText,
    deleteMessage,
  });
  runtime.onToolExecutionStart({ toolCallId: "first", toolName: "read", args: {} });
  await vi.advanceTimersByTimeAsync(0);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  runtime.onToolExecutionEnd({ toolCallId: "first", isError: false });
  runtime.onToolExecutionStart({ toolCallId: "second", toolName: "read", args: {} });
  await vi.advanceTimersByTimeAsync(999);
  expect(editMessageText).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(editMessageText).toHaveBeenCalledTimes(1);
  expect(editMessageText.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
    text: expect.stringContaining("2 tools"),
  }));
  runtime.onToolExecutionEnd({ toolCallId: "second", isError: false });
  await runtime.finish();
  await vi.advanceTimersByTimeAsync(1000);
  expect(editMessageText).toHaveBeenCalledTimes(1);
  expect(deleteMessage).toHaveBeenCalledWith(123, 42);
});
