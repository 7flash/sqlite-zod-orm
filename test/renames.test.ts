import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src/index";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const file = () => { const d = mkdtempSync(join(tmpdir(), "szo-renames-")); dirs.push(d); return join(d, "app.db"); };

test("a declared rename carries the old column's values into the new field", () => {
  const path = file();
  const v1 = new Database(path, { users: z.object({ name: z.string(), age: z.number() }) }, { reactive: false });
  v1.users.insert({ name: "Ada", age: 36 });
  v1.users.insert({ name: "Alan", age: 41 });
  v1.close();

  const schema = { users: z.object({ fullName: z.string(), age: z.number() }) };
  const v2 = new Database(path, schema, { reactive: false, renames: { users: { name: "fullName" } } });
  expect(v2.users.select().orderBy("id", "asc").all().map((u: any) => [u.fullName, u.age])).toEqual([["Ada", 36], ["Alan", 41]]);
  v2.close();

  // Reopening with the rename still configured is harmless once the old column is gone.
  const v3 = new Database(path, schema, { reactive: false, renames: { users: { name: "fullName" } } });
  expect(v3.users.select().count()).toBe(2);
  v3.close();
});

test("without the rename, dropping the populated column is still refused (unchanged)", () => {
  const path = file();
  const v1 = new Database(path, { users: z.object({ name: z.string() }) }, { reactive: false });
  v1.users.insert({ name: "Ada" });
  v1.close();
  expect(() => new Database(path, { users: z.object({ fullName: z.string() }) }, { reactive: false }))
    .toThrow('Cannot automatically drop populated column "users.name"');
});

test("invalid rename entries are refused at startup", () => {
  const schema = { users: z.object({ fullName: z.string(), name: z.string().optional() }) };
  const open = (renames: any) => () => new Database(":memory:", schema, { reactive: false, renames }).close();
  expect(open({ people: { name: "fullName" } })).toThrow("renames: unknown table 'people'");
  expect(open({ users: { name: "nickname" } })).toThrow("target 'nickname' is not a field");
  expect(open({ users: { fullName: "fullName" } })).toThrow("renamed to itself");
  expect(open({ users: { name: "fullName" } })).toThrow("'name' is still a field of the schema");
});
