import { expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/index";

test("findBackups does not report a live table as another table's snapshot", () => {
  const db = new Database(":memory:", {
    users: z.object({ name: z.string() }),
    users_v1: z.object({ note: z.string() }),
  });
  db.users_v1.insert({ note: "live row" });
  const backups = db.migrator().findBackups();
  expect(backups.map((b) => b.backup)).not.toContain("users_v1");
});

test("findBackups still finds a real snapshot", () => {
  const db = new Database(":memory:", {
    users: z.object({ name: z.string() }),
  });
  db.exec(`CREATE TABLE "users_v2" (id INTEGER PRIMARY KEY, name TEXT)`);
  const backups = db.migrator().findBackups();
  expect(backups.map((b) => [b.table, b.backup, b.version])).toContainEqual(["users", "users_v2", 2]);
});

test("prune keeps the newest snapshots per table and supports dry runs", () => {
  const db = new Database(":memory:", {
    users: z.object({ name: z.string() }),
    users_v1: z.object({ note: z.string() }), // a live table, never pruned
  });
  for (const v of [2, 3, 4]) db.exec(`CREATE TABLE "users_v${v}" (id INTEGER PRIMARY KEY)`);
  const dry = db.migrator().prune({ keep: 1, dryRun: true });
  expect(dry.kept.map((b) => b.backup)).toEqual(["users_v4"]);
  expect(dry.dropped.map((b) => b.backup).sort()).toEqual(["users_v2", "users_v3"]);
  expect(db.migrator().findBackups().length).toBe(3);

  db.migrator().prune({ keep: 1 });
  expect(db.migrator().findBackups().map((b) => b.backup)).toEqual(["users_v4"]);
  db.users_v1.insert({ note: "still here" });
  expect(db.users_v1.select().all().length).toBe(1);

  db.migrator().prune({ keep: 0 });
  expect(db.migrator().findBackups()).toEqual([]);
  expect(() => db.migrator().prune({ keep: -1 })).toThrow(/keep/);
});
