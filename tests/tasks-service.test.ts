import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { TasksService } from "../src/tasks-service.js";
import { openTasksStore } from "../src/tasks-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tasks-service-"));
  roots.push(root);
  const store = openTasksStore(join(root, "tasks.db"));
  const service = new TasksService(store, {
    owner: "isaac",
    now: () => Date.UTC(2026, 7, 3, 12),
    createId: (() => {
      let next = 0;
      return () => `task-${++next}`;
    })(),
  });
  return { store, service };
}

describe("tasks service", () => {
  it("creates, updates, transitions, reopens, and permanently deletes tasks", async () => {
    const { store, service } = await fixture();
    const task = service.create({
      title: "  Call the vet  ",
      startDate: "2026-08-04",
      dueDate: "2026-08-05",
      notes: "Bring records",
    });

    expect(task).toMatchObject({
      id: "task-1",
      title: "Call the vet",
      status: "open",
      assignee: "isaac",
      startDate: "2026-08-04",
      dueDate: "2026-08-05",
      notes: "Bring records",
      createdAt: Date.UTC(2026, 7, 3, 12),
      updatedAt: Date.UTC(2026, 7, 3, 12),
      completedAt: null,
      cancelledAt: null,
    });

    const updated = service.update(task.id, {
      title: "Call the veterinarian",
      assignee: "household",
      startDate: null,
      dueDate: "2026-08-06",
      notes: null,
    });
    expect(updated).toMatchObject({
      title: "Call the veterinarian",
      assignee: "household",
      startDate: null,
      dueDate: "2026-08-06",
      notes: null,
    });

    expect(service.complete(task.id)).toMatchObject({ status: "completed", completedAt: expect.any(Number) });
    expect(service.reopen(task.id)).toMatchObject({ status: "open", completedAt: null, cancelledAt: null });
    expect(service.cancel(task.id)).toMatchObject({ status: "cancelled", cancelledAt: expect.any(Number) });
    expect(service.reopen(task.id)).toMatchObject({ status: "open" });
    service.delete(task.id);
    expect(() => service.get(task.id)).toThrow(/not found/i);
    store.close();
  });

  it("hides future work, provides deterministic date views, and keeps closed tasks searchable", async () => {
    const { store, service } = await fixture();
    const create = (input: Parameters<TasksService["create"]>[0]) => service.create(input);
    const today = create({ title: "Today", dueDate: "2026-08-03" });
    create({ title: "This week", dueDate: "2026-08-08" });
    create({ title: "Next week", dueDate: "2026-08-10" });
    create({ title: "Overdue", dueDate: "2026-08-01" });
    create({ title: "Someday", assignee: "emma" });
    create({ title: "Future", startDate: "2026-08-10", dueDate: "2026-08-11" });
    const completed = create({ title: "Finished project", dueDate: "2026-08-02" });
    service.complete(completed.id);
    const cancelled = create({ title: "Cancelled project" });
    service.cancel(cancelled.id);

    expect(service.list({ view: "open", asOf: "2026-08-03", limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Overdue", "Today", "This week", "Next week", "Someday"]);
    expect(service.list({ view: "upcoming", asOf: "2026-08-03", limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Today", "This week", "Next week"]);
    expect(service.list({ view: "due_this_week", asOf: "2026-08-03", limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Today", "This week"]);
    expect(service.list({ view: "overdue", asOf: "2026-08-03", limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Overdue"]);
    expect(service.list({ view: "assigned_to", asOf: "2026-08-03", assignee: "emma", limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Someday"]);
    expect(service.list({ view: "undated", asOf: "2026-08-03", limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Someday"]);
    expect(service.search("project", { limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Cancelled project", "Finished project"]);
    expect(service.search("Future", { limit: 50 }).tasks.map((task) => task.title))
      .toEqual(["Future"]);
    expect(today.id).toBeDefined();
    store.close();
  });

  it("rejects invalid dates and inverted date ranges", async () => {
    const { store, service } = await fixture();
    expect(() => service.create({ title: "Bad", dueDate: "2026-02-30" })).toThrow(/date/i);
    expect(() => service.create({ title: "Inverted", startDate: "2026-08-05", dueDate: "2026-08-04" })).toThrow(/due/i);
    expect(() => service.update("missing", { dueDate: "2026-08-04" })).toThrow(/not found/i);
    store.close();
  });
});
