import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/index";

function db() {
  return new Database(":memory:", {
    users: z.object({ name: z.string(), age: z.number() }),
  });
}

describe("query builder identifiers and clauses", () => {
  test("ORDER BY direction is allow-listed", () => {
    const d = db();
    d.users.insert({ name: "a", age: 1 });
    expect(() =>
      d.users.select().orderBy("name", "asc; DELETE FROM users --" as any).all(),
    ).toThrow(/direction/);
    expect(d.users.select().all().length).toBe(1);
    expect(d.users.select().orderBy("age", "desc").all().length).toBe(1);
  });

  test("ORDER BY and GROUP BY fields are quoted identifiers", () => {
    const d = db();
    d.users.insert({ name: "a", age: 1 });
    const evil = 'name"; DELETE FROM users; --' as any;
    // The name stays one quoted identifier: the query may fail or sort by a
    // constant, but the injected DELETE never runs.
    try { d.users.select().orderBy(evil).all(); } catch {}
    expect(d.users.select().all().length).toBe(1);
    try { d.users.select("name").groupBy(evil).all(); } catch {}
    expect(d.users.select().all().length).toBe(1);
  });

  test("limit and offset must be non-negative integers", () => {
    const d = db();
    d.users.insert({ name: "a", age: 1 });
    d.users.insert({ name: "b", age: 2 });
    expect(() => d.users.select().limit("1 UNION SELECT 1" as any).all()).toThrow(/limit/);
    expect(() => d.users.select().limit(-1).all()).toThrow(/limit/);
    expect(() => d.users.select().limit(1.5).all()).toThrow(/limit/);
    expect(() => d.users.select().offset("0; --" as any).all()).toThrow(/offset/);
    expect(d.users.select().orderBy("age").limit(1).offset(1).all().map((u: any) => u.name)).toEqual(["b"]);
    expect(d.users.select().orderBy("age").offset(1).all().map((u: any) => u.name)).toEqual(["b"]);
    expect(d.users.select().limit(1).exists()).toBe(true);
  });
});
