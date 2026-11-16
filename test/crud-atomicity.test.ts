import { afterEach, expect, test } from "bun:test";
import { Database, z } from "../src";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const schema = {
  users: z.object({
    email: z.string(),
    name: z.string(),
  }),
};

const dirs: string[] = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-zod-orm-"));
  dirs.push(dir);
  return join(dir, "test.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // On Windows a terminated worker may still hold the file for a moment.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {}
  }
});

test("upsert serializes competing writers before its lookup", async () => {
  const path = tempDatabasePath();
  const db = new Database(path, schema, { busyTimeout: 3000 });
  db.exec(
    `CREATE UNIQUE INDEX users_email_unique ON users(email)`,
  );

  const worker = new Worker(
    new URL("./upsert.worker.ts", import.meta.url),
  );
  const flag = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const ready = new Promise<void>((resolve) => {
    worker.onmessage = (event) => {
      if (event.data.type === "ready") resolve();
    };
  });

  try {
    worker.postMessage({ type: "init", path, flag });
    await ready;

    let resolveResult!: (value: any) => void;
    const result = new Promise<any>((resolve) => {
      resolveResult = resolve;
    });
    worker.onmessage = (event) => {
      if (event.data.type === "result") resolveResult(event.data);
    };

    // Hold a WAL write reservation while the second connection starts.
    // The old implementation can read the missing row, then fail to
    // upgrade its read transaction when it attempts the INSERT.
    db.exec("BEGIN IMMEDIATE");
    worker.postMessage({ type: "upsert" });

    // Old implementation: beforeInsert signals after the missing-row
    // SELECT. Fixed implementation: BEGIN IMMEDIATE blocks before SELECT.
    Atomics.wait(new Int32Array(flag), 0, 0, 250);

    db.users.insert({
      email: "race@example.com",
      name: "main",
    });
    db.exec("COMMIT");

    const outcome = await result;
    expect(outcome.error).toBeUndefined();
    expect(outcome.entity.name).toBe("worker");

    const rows = db.users.select()
      .where({ email: "race@example.com" })
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("worker");
  } finally {
    worker.terminate();
    db.close();
  }
});

test("insertMany rolls back the whole batch on a constraint error", () => {
  let afterInsertCalls = 0;
  const db = new Database(
    tempDatabasePath(),
    schema,
    {
      hooks: {
        users: {
          afterInsert: () => {
            afterInsertCalls++;
          },
        },
      },
    },
  );
  db.exec(
    `CREATE UNIQUE INDEX users_email_unique ON users(email)`,
  );

  try {
    db.users.insert({
      email: "existing@example.com",
      name: "existing",
    });
    afterInsertCalls = 0;

    expect(() =>
      db.users.insertMany([
        { email: "rolled-back@example.com", name: "first" },
        { email: "existing@example.com", name: "duplicate" },
      ]),
    ).toThrow();

    expect(
      db.users.select()
        .where({ email: "rolled-back@example.com" })
        .all(),
    ).toHaveLength(0);
    expect(afterInsertCalls).toBe(0);
  } finally {
    db.close();
  }
});
