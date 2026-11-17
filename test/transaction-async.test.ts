import { expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/index";

test("an async transaction callback throws and rolls back its synchronous writes", async () => {
  const db = new Database(":memory:", { items: z.object({ v: z.string() }) });
  expect(() =>
    db.transaction(async () => {
      db.items.insert({ v: "before await" });
      await Promise.resolve();
      db.items.insert({ v: "after await" });
    }),
  ).toThrow(/must be synchronous/);
  await new Promise((r) => setTimeout(r, 10));
  expect(db.items.select().all().map((r: any) => r.v)).not.toContain("before await");
  db.close();
});

test("a synchronous transaction returns its value and nests with savepoints", () => {
  const db = new Database(":memory:", { items: z.object({ v: z.string() }) });
  const out = db.transaction(() => {
    db.items.insert({ v: "outer" });
    try {
      db.transaction(() => {
        db.items.insert({ v: "inner" });
        throw new Error("inner fails");
      });
    } catch {}
    return 42;
  });
  expect(out).toBe(42);
  expect(db.items.select().all().map((r: any) => r.v)).toEqual(["outer"]);
  db.close();
});
