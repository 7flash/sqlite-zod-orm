import { expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/index";

const view = { schema: z.object({ name: z.string() }), as: "SELECT name FROM users" };

test("bulk writes through a view are refused", () => {
  const db = new Database(":memory:", { users: z.object({ name: z.string() }) }, { views: { names: view } });
  db.users.insert({ name: "a" });
  expect(() => (db as any).names.select().updateAll({ name: "x" })).toThrow(/view/);
  expect(() => (db as any).names.select().deleteAll()).toThrow(/view/);
  expect(db.users.select().all().map((u: any) => u.name)).toEqual(["a"]);
  db.close();
});

test("a view may not share a table's name", () => {
  expect(
    () =>
      new Database(":memory:", { users: z.object({ name: z.string() }) }, {
        views: { users: { schema: z.object({ name: z.string() }), as: "SELECT 1 AS name" } },
      }),
  ).toThrow(/not a view/);
});
