import { chmodSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type TaskStatus = "open" | "completed" | "cancelled";
export type TaskView = "open" | "upcoming" | "due_this_week" | "overdue" | "assigned_to" | "undated";

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
  startDate: string | null;
  dueDate: string | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  cancelledAt: number | null;
}

export interface TaskListQuery {
  view: TaskView;
  asOf: string;
  assignee?: string;
  limit: number;
}

export interface TaskListResult {
  tasks: Task[];
  truncated: boolean;
}

export interface CreateTaskInput {
  id: string;
  title: string;
  assignee: string;
  startDate: string | null;
  dueDate: string | null;
  notes: string | null;
  now: number;
}

export interface UpdateTaskInput {
  id: string;
  title: string;
  assignee: string;
  startDate: string | null;
  dueDate: string | null;
  notes: string | null;
  now: number;
}

export interface TasksStore {
  readonly schemaVersion: number;
  create(input: CreateTaskInput): Task;
  get(id: string): Task | undefined;
  update(input: UpdateTaskInput): Task;
  transition(id: string, status: TaskStatus, now: number): Task;
  delete(id: string): void;
  list(query: TaskListQuery): TaskListResult;
  search(query: string, limit: number): TaskListResult;
  close(): void;
}

const SCHEMA_VERSION = 1;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface TaskRow {
  id: string;
  title: string;
  status: string;
  assignee: string;
  start_date: string | null;
  due_date: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || day! > 31) return false;
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month! - 1 && date.getUTCDate() === day;
}

export function validateTaskDate(value: string | null | undefined, label = "date"): void {
  if (value !== null && value !== undefined && !validDate(value)) {
    throw new Error(`${label} must be a valid YYYY-MM-DD date`);
  }
}

function taskFromRow(row: TaskRow): Task {
  if (!(["open", "completed", "cancelled"] as string[]).includes(row.status)) {
    throw new Error("Task has an invalid stored status");
  }
  return {
    id: row.id,
    title: row.title,
    status: row.status as TaskStatus,
    assignee: row.assignee,
    startDate: row.start_date,
    dueDate: row.due_date,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  };
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function weekEnd(asOf: string): string {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() + (6 - daysFromMonday));
  return date.toISOString().slice(0, 10);
}

function migrate(db: DatabaseSync): number {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Tasks database schema ${current} is newer than supported ${SCHEMA_VERSION}`);
  }
  if (current === 0) {
    transaction(db, () => {
      db.exec(`
        CREATE TABLE task (
          id           TEXT PRIMARY KEY,
          title        TEXT NOT NULL,
          status       TEXT NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
          assignee     TEXT NOT NULL,
          start_date   TEXT,
          due_date     TEXT,
          notes        TEXT,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL,
          completed_at INTEGER,
          cancelled_at INTEGER
        ) STRICT;
        CREATE INDEX task_open_due ON task(status, due_date, start_date);
        CREATE INDEX task_assignee ON task(assignee, status, due_date);
        CREATE INDEX task_dates ON task(start_date, due_date);
        PRAGMA user_version = 1;
      `);
    });
  }
  return SCHEMA_VERSION;
}

export function openTasksStore(dbPath: string): TasksStore {
  const db = new DatabaseSync(dbPath, { timeout: 5_000 });
  chmodSync(dbPath, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  const schemaVersion = migrate(db);
  const getStatement = db.prepare("SELECT * FROM task WHERE id = ?");
  const selectRows = (sql: string, ...params: SQLInputValue[]): Task[] =>
    (db.prepare(sql).all(...params) as unknown as TaskRow[]).map(taskFromRow);

  const get = (id: string): Task | undefined => {
    const row = getStatement.get(id) as unknown as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  };

  return {
    schemaVersion,
    create(input) {
      return transaction(db, () => {
        db.prepare(`
          INSERT INTO task (id, title, status, assignee, start_date, due_date, notes, created_at, updated_at, completed_at, cancelled_at)
          VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL, NULL)
        `).run(input.id, input.title, input.assignee, input.startDate, input.dueDate, input.notes, input.now, input.now);
        return get(input.id)!;
      });
    },
    get,
    update(input) {
      return transaction(db, () => {
        const result = db.prepare(`
          UPDATE task
          SET title = ?, assignee = ?, start_date = ?, due_date = ?, notes = ?, updated_at = ?
          WHERE id = ?
        `).run(input.title, input.assignee, input.startDate, input.dueDate, input.notes, input.now, input.id);
        if (result.changes !== 1) throw new Error("Task not found");
        return get(input.id)!;
      });
    },
    transition(id, status, now) {
      return transaction(db, () => {
        const result = status === "completed"
          ? db.prepare("UPDATE task SET status = 'completed', completed_at = ?, cancelled_at = NULL, updated_at = ? WHERE id = ?").run(now, now, id)
          : status === "cancelled"
            ? db.prepare("UPDATE task SET status = 'cancelled', completed_at = NULL, cancelled_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
            : db.prepare("UPDATE task SET status = 'open', completed_at = NULL, cancelled_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
        if (result.changes !== 1) throw new Error("Task not found");
        return get(id)!;
      });
    },
    delete(id) {
      transaction(db, () => {
        db.prepare("DELETE FROM task WHERE id = ?").run(id);
      });
    },
    list(query) {
      const params: SQLInputValue[] = [];
      const conditions = ["status = 'open'"];
      conditions.push("(start_date IS NULL OR start_date <= ?)");
      params.push(query.asOf);
      if (query.view === "upcoming") {
        conditions.push("due_date IS NOT NULL", "due_date >= ?");
        params.push(query.asOf);
      } else if (query.view === "due_this_week") {
        conditions.push("due_date IS NOT NULL", "due_date >= ?", "due_date <= ?");
        params.push(query.asOf, weekEnd(query.asOf));
      } else if (query.view === "overdue") {
        conditions.push("due_date IS NOT NULL", "due_date < ?");
        params.push(query.asOf);
      } else if (query.view === "assigned_to") {
        if (!query.assignee) throw new Error("Assignee is required for assigned_to view");
        conditions.push("assignee = ?");
        params.push(query.assignee);
      } else if (query.view === "undated") {
        conditions.push("due_date IS NULL");
      }
      const rows = selectRows(
        `SELECT * FROM task WHERE ${conditions.join(" AND ")} ORDER BY due_date IS NULL, due_date, created_at, id LIMIT ?`,
        ...params,
        query.limit + 1,
      );
      return { tasks: rows.slice(0, query.limit), truncated: rows.length > query.limit };
    },
    search(query, limit) {
      const pattern = `%${query.replace(/[%_\\]/g, (value) => `\\${value}`)}%`;
      const rows = selectRows(
        `SELECT * FROM task
         WHERE title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR assignee LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
        pattern,
        pattern,
        pattern,
        limit + 1,
      );
      return { tasks: rows.slice(0, limit), truncated: rows.length > limit };
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
