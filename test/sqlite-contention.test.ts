import { describe, expect, test } from "bun:test";
import { Database as RawDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src";

const schemas = { counters: z.object({ value: z.number() }) };
const workerPath = join(import.meta.dir, "fixtures", "contention-worker.ts");

async function startWorker(file: string, action: string) {
  const child = Bun.spawn([process.execPath, workerPath, file, action], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  expect(new TextDecoder().decode(ready.value).trim()).toBe("ready");
  reader.releaseLock();
  return child;
}

describe("SQLite process contention", () => {
  test("opening waits for another process and respects a zero timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orm-lock-"));
    const file = join(dir, "db.sqlite");
    const seed = new Database(file, schemas);
    seed.close();
    const child = await startWorker(file, "lock");
    try {
      expect(() => new Database(file, schemas, { busyTimeout: 0 })).toThrow();
      const start = performance.now();
      const db = new Database(file, schemas);
      try {
        expect(performance.now() - start).toBeGreaterThan(100);
        expect(
          db.raw<{ timeout: number }>("PRAGMA busy_timeout")[0]?.timeout,
        ).toBe(5000);
      } finally {
        db.close();
      }
      expect(await child.exited).toBe(0);
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("8 simultaneous opens migrate once and preserve all 1200 read/write increments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orm-processes-"));
    const file = join(dir, "db.sqlite");
    const seed = new Database(file, schemas);
    seed.counters.insert({ value: 0 });
    seed.close();
    const children: Awaited<ReturnType<typeof startWorker>>[] = [];
    try {
      for (let i = 0; i < 8; i++)
        children.push(await startWorker(file, "increment"));
      for (const child of children) {
        child.stdin.write("start\n");
        child.stdin.end();
      }
      for (const child of children) {
        const error = await new Response(child.stderr).text();
        expect(error).toBe("");
        expect(await child.exited).toBe(0);
      }
      const raw = new RawDatabase(file);
      try {
        expect(raw.query("SELECT value, label FROM counters").get()).toEqual({
          value: 1200,
          label: "counter",
        });
        expect(
          raw
            .query(
              "SELECT name FROM sqlite_master WHERE name LIKE 'counters_v%'",
            )
            .all(),
        ).toEqual([]);
        expect(
          raw
            .query("SELECT COUNT(*) AS n FROM _changes WHERE op = 'update'")
            .get(),
        ).toEqual({ n: 1200 });
        expect(
          raw
            .query(
              "SELECT name FROM sqlite_master WHERE tbl_name = 'counters' AND type = 'index'",
            )
            .all(),
        ).toHaveLength(2);
        expect(raw.query("SELECT value FROM totals").get()).toEqual({
          value: 1200,
        });
      } finally {
        raw.close();
      }
    } finally {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  test("immediate locks before callback; explicit deferred mode and nested savepoints work", () => {
    const dir = mkdtempSync(join(tmpdir(), "orm-transaction-"));
    const file = join(dir, "db.sqlite");
    const db = new Database(file, schemas, { busyTimeout: 0 });
    const other = new Database(file, schemas, { busyTimeout: 0 });
    try {
      db.counters.insert({ value: 0 });
      expect(
        db.transaction(() => {
          expect(() => other.exec("UPDATE counters SET value = 99")).toThrow();
          expect(() =>
            db.transaction(() => {
              db.counters.update(1, { value: 50 });
              throw new Error("rollback nested");
            }),
          ).toThrow("rollback nested");
          expect(db.counters.get(1)?.value).toBe(0);
          db.counters.update(1, { value: 1 });
          return "committed";
        }),
      ).toBe("committed");
      expect(() =>
        db.transaction(
          () => {
            db.counters.get(1);
            other.counters.update(1, { value: 2 });
            db.counters.update(1, { value: 3 });
          },
          { mode: "deferred" },
        ),
      ).toThrow();
      expect(db.counters.get(1)?.value).toBe(2);
      other.exec("BEGIN IMMEDIATE");
      let called = false;
      expect(() =>
        db.transaction(() => {
          called = true;
        }),
      ).toThrow();
      expect(called).toBe(false);
      other.exec("ROLLBACK");
    } finally {
      other.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("invalid busy timeout is rejected", () => {
    for (const busyTimeout of [-1, 1.5, NaN, Infinity, 2147483648]) {
      expect(() => new Database(":memory:", schemas, { busyTimeout })).toThrow(
        "busyTimeout",
      );
    }
  });
});
