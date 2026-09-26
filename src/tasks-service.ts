import { randomUUID } from "node:crypto";

import {
  type CreateTaskInput,
  type Task,
  type TaskListQuery,
  type TaskListResult,
  type TaskStatus,
  type TasksStore,
  type UpdateTaskInput,
  validateTaskDate,
} from "./tasks-store.js";

export type TaskServiceErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "INVALID_TRANSITION" | "PERSISTENCE_ERROR";

export class TaskServiceError extends Error {
  readonly code: TaskServiceErrorCode;

  constructor(code: TaskServiceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskServiceError";
    this.code = code;
  }
}

export interface TasksServiceOptions {
  owner: string;
  now?: () => number;
  createId?: () => string;
}

export interface CreateTaskRequest {
  title: string;
  assignee?: string;
  startDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
}

export interface UpdateTaskRequest {
  title?: string;
  assignee?: string;
  startDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
}

function clean(value: string | undefined, label: string, max: number): string {
  const result = value?.trim().replace(/\s+/gu, " ") ?? "";
  if (!result) throw new TaskServiceError("INVALID_INPUT", `${label} must not be empty`);
  if (result.length > max) throw new TaskServiceError("INVALID_INPUT", `${label} is too long`);
  return result;
}

function optionalClean(value: string | null | undefined, label: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  const result = value.trim();
  if (result.length > max) throw new TaskServiceError("INVALID_INPUT", `${label} is too long`);
  return result || null;
}

function validateDates(startDate: string | null, dueDate: string | null): void {
  try {
    validateTaskDate(startDate, "start date");
    validateTaskDate(dueDate, "due date");
  } catch (error) {
    throw new TaskServiceError("INVALID_INPUT", error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (startDate && dueDate && startDate > dueDate) {
    throw new TaskServiceError("INVALID_INPUT", "Due date must not be before the start date");
  }
}

function mapError(error: unknown): TaskServiceError {
  if (error instanceof TaskServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return new TaskServiceError("NOT_FOUND", "That task was not found", { cause: error });
  return new TaskServiceError("PERSISTENCE_ERROR", "The task database could not accept that action. Nothing was changed.", { cause: error });
}

export class TasksService {
  readonly #store: TasksStore;
  readonly #owner: string;
  readonly #now: () => number;
  readonly #createId: () => string;

  constructor(store: TasksStore, options: TasksServiceOptions) {
    this.#store = store;
    this.#owner = clean(options.owner, "Owner", 64);
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }

  create(input: CreateTaskRequest): Task {
    const title = clean(input.title, "Title", 200);
    const assignee = clean(input.assignee ?? this.#owner, "Assignee", 64);
    const startDate = input.startDate ?? null;
    const dueDate = input.dueDate ?? null;
    const notes = optionalClean(input.notes, "Notes", 4_000);
    validateDates(startDate, dueDate);
    try {
      const value: CreateTaskInput = {
        id: this.#createId(), title, assignee, startDate, dueDate, notes, now: this.#now(),
      };
      return this.#store.create(value);
    } catch (error) {
      throw mapError(error);
    }
  }

  get(id: string): Task {
    const task = this.#store.get(clean(id, "Task ID", 128));
    if (!task) throw new TaskServiceError("NOT_FOUND", "That task was not found");
    return task;
  }

  update(id: string, changes: UpdateTaskRequest): Task {
    const current = this.get(id);
    const title = changes.title === undefined ? current.title : clean(changes.title, "Title", 200);
    const assignee = changes.assignee === undefined ? current.assignee : clean(changes.assignee, "Assignee", 64);
    const startDate = changes.startDate === undefined ? current.startDate : changes.startDate;
    const dueDate = changes.dueDate === undefined ? current.dueDate : changes.dueDate;
    const notes = changes.notes === undefined ? current.notes : optionalClean(changes.notes, "Notes", 4_000);
    validateDates(startDate, dueDate);
    try {
      const value: UpdateTaskInput = {
        id: current.id, title, assignee, startDate, dueDate, notes, now: this.#now(),
      };
      return this.#store.update(value);
    } catch (error) {
      throw mapError(error);
    }
  }

  complete(id: string): Task {
    return this.transition(id, "completed");
  }

  cancel(id: string): Task {
    return this.transition(id, "cancelled");
  }

  reopen(id: string): Task {
    return this.transition(id, "open");
  }

  delete(id: string): void {
    const current = this.get(id);
    try {
      this.#store.delete(current.id);
    } catch (error) {
      throw mapError(error);
    }
  }

  list(query: TaskListQuery): TaskListResult {
    try {
      validateTaskDate(query.asOf, "as-of date");
      if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
        throw new TaskServiceError("INVALID_INPUT", "Limit must be between 1 and 100");
      }
      if (!["open", "upcoming", "due_this_week", "overdue", "assigned_to", "undated"].includes(query.view)) {
        throw new TaskServiceError("INVALID_INPUT", "The task view is invalid");
      }
      const assignee = query.assignee === undefined ? undefined : clean(query.assignee, "Assignee", 64);
      return this.#store.list({ ...query, ...(assignee === undefined ? {} : { assignee }) });
    } catch (error) {
      throw mapError(error);
    }
  }

  search(query: string, options: { limit: number }): TaskListResult {
    const text = clean(query, "Search query", 200);
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new TaskServiceError("INVALID_INPUT", "Limit must be between 1 and 100");
    }
    return this.#store.search(text, options.limit);
  }

  private transition(id: string, status: TaskStatus): Task {
    const current = this.get(id);
    if (status === "completed" && current.status !== "open") {
      throw new TaskServiceError("INVALID_TRANSITION", "Only open tasks can be completed");
    }
    if (status === "cancelled" && current.status !== "open") {
      throw new TaskServiceError("INVALID_TRANSITION", "Only open tasks can be cancelled");
    }
    if (status === "open" && current.status === "open") {
      throw new TaskServiceError("INVALID_TRANSITION", "That task is already open");
    }
    try {
      return this.#store.transition(current.id, status, this.#now());
    } catch (error) {
      throw mapError(error);
    }
  }
}
