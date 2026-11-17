import { expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/index";

test("the prepared statement cache stays bounded with varying raw SQL", () => {
  const db = new Database(":memory:", { items: z.object({ n: z.number() }) }, { reactive: false });
  db.items.insert({ n: 1 });
  for (let i = 0; i < 2_000; i++) db.raw(`SELECT n, ${i} AS k FROM items`);
  const cache = (db as any)._stmtCache as Map<string, unknown>;
  expect(cache.size).toBeLessThanOrEqual(500);
  // Recently used statements stay usable after older ones are dropped.
  expect(db.raw("SELECT n FROM items")).toEqual([{ n: 1 }]);
  expect(db.items.select().all().length).toBe(1);
  db.close();
});
