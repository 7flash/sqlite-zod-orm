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
