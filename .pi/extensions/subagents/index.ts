import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type Model = typeof MODELS[number];
interface Target { chatId: number; threadId?: number }
interface Task { task: string; context?: string; model?: Model; thinking?: Thinking }
interface Service {
  launch(input: { tasks: Task[]; model?: Model; thinking?: Thinking; origin?: Target }): Promise<{ batchId: string; jobIds: string[] }>;
  list(filter?: { status?: "active" | "terminal" }): unknown[];
  inspect(jobId: string): unknown;
  collect(input: { batchId?: string; jobIds?: string[] }): { jobs: unknown[] };
  cancel(input: { batchId?: string; jobId?: string }): Promise<void>;
}
interface TelegramTargetScope { getActiveTarget(): Target | undefined }
const MODELS = [
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
] as const;
const DEFAULT_MODEL: Model = MODELS[0];
const SERVICE_KEY = Symbol.for("pi-telegram-bridge.subagent-registry");
const TARGET_KEY = Symbol.for("pi-telegram-bridge.target-scope-registry");

function getService(): Service {
  const value = (globalThis as Record<PropertyKey, unknown>)[SERVICE_KEY];
  const service = value && typeof value === "object" ? (value as { service?: unknown }).service : undefined;
  if (!service || typeof service !== "object") throw new Error("Background subagent service is unavailable outside the bridge runtime");
  return service as Service;
}
function getOrigin(): Target | undefined {
  const value = (globalThis as Record<PropertyKey, unknown>)[TARGET_KEY];
  const scope = value && typeof value === "object" ? (value as { provider?: unknown }).provider : undefined;
  return scope && typeof scope === "object" && typeof (scope as TelegramTargetScope).getActiveTarget === "function"
    ? (scope as TelegramTargetScope).getActiveTarget()
    : undefined;
}
function validateModel(model: Model, thinking: Thinking, ctx: ExtensionContext): void {
  const slash = model.indexOf("/");
  const resolved = slash < 1 || slash === model.length - 1
    ? undefined
    : ctx.modelRegistry.getAvailable().find((candidate) => candidate.provider === model.slice(0, slash) && candidate.id === model.slice(slash + 1));
  if (!resolved) {
    throw new Error(`Unknown or unavailable subagent model: ${model}`);
  }
  if (!resolved.reasoning && thinking !== "off") throw new Error(`Subagent model ${model} does not support thinking level ${thinking}`);
}

const ThinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const ModelSchema = StringEnum(MODELS);
const TaskSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 16_384 }),
  context: Type.Optional(Type.String({ maxLength: 32_768 })),
  model: Type.Optional(ModelSchema),
  thinking: Type.Optional(ThinkingSchema),
});

export default function backgroundSubagents(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "background_subagents",
    label: "Background subagents",
    description: "Launch and manage isolated, bounded, read-only background research jobs. Launch explicitly listed independent tasks, returns immediately, and triggers one parent synthesis turn when the batch finishes. Operations: launch, list, inspect, cancel, collect.",
    promptSnippet: "Delegate independent read-only research tasks in the background",
    promptGuidelines: [
      "Use background_subagents only for independent, explicitly listed read-only research or review that should not block the conversation; skip it for changes, recurring work, or tasks that depend on each other.",
      "After launch, briefly report the batch ID and stay available; completion triggers one synthesis turn, so the user never needs to poll.",
      "On that completion turn, collect the batch once, summarize findings and failures, and do not launch nested subagents.",
    ],
    parameters: Type.Object({
      operation: StringEnum(["launch", "list", "inspect", "cancel", "collect"] as const),
      tasks: Type.Optional(Type.Array(TaskSchema)),
      model: Type.Optional(ModelSchema),
      thinking: Type.Optional(ThinkingSchema),
      status: Type.Optional(StringEnum(["active", "terminal"] as const)),
      job_id: Type.Optional(Type.String()),
      job_ids: Type.Optional(Type.Array(Type.String())),
      batch_id: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const service = getService();
      let result: unknown;
      if (params.operation === "launch") {
        if (!params.tasks?.length) throw new Error("launch requires at least one task");
        for (const task of params.tasks) {
          validateModel(task.model ?? params.model ?? DEFAULT_MODEL, task.thinking ?? params.thinking ?? "high", ctx);
        }
        const origin = getOrigin();
        result = await service.launch({ tasks: params.tasks, ...(params.model ? { model: params.model } : {}), ...(params.thinking ? { thinking: params.thinking } : {}), ...(origin ? { origin } : {}) });
      } else if (params.operation === "list") {
        result = service.list(params.status ? { status: params.status } : undefined);
      } else if (params.operation === "inspect") {
        if (!params.job_id) throw new Error("inspect requires job_id");
        result = service.inspect(params.job_id);
      } else if (params.operation === "cancel") {
        if (!params.job_id && !params.batch_id) throw new Error("cancel requires job_id or batch_id");
        await service.cancel(params.batch_id ? { batchId: params.batch_id } : { jobId: params.job_id! });
        result = { cancelled: true };
      } else {
        if (!params.batch_id && !params.job_ids?.length) throw new Error("collect requires batch_id or job_ids");
        result = service.collect(params.batch_id ? { batchId: params.batch_id } : { jobIds: params.job_ids! });
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
