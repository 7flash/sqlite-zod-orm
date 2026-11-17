import { expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/index";

function db() {
  const d = new Database(":memory:", { items: z.object({ n: z.number(), g: z.string() }) });
  for (let i = 1; i <= 7; i++) d.items.insert({ n: i, g: i % 2 ? "odd" : "even" });
  return d;
}

test("paginate validates page and perPage", () => {
  const d = db();
  for (const [p, pp] of [[0, 2], [-1, 2], [1.5, 2], [1, 0], [1, -3], [1, 2.5], [1, 1e6]])
    expect(() => d.items.select().paginate(p, pp)).toThrow(TypeError);
  d.close();
});

test("paginate does not change the builder and counts the whole result", () => {
  const d = db();
  const q = d.items.select().where({ g: "odd" });
  const first = q.paginate(1, 2);
  expect(first.total).toBe(4);
  expect(first.pages).toBe(2);
  expect(first.data.map((r: any) => r.n)).toEqual([1, 3]);
  // The same builder still means "all odd rows".
  expect(q.all().length).toBe(4);
  expect(q.paginate(2, 2).data.map((r: any) => r.n)).toEqual([5, 7]);
  expect(q.count()).toBe(4);
  d.close();
});

test("total is right for grouped queries and pages are ordered by id by default", () => {
  const d = db();
  const grouped = d.items.select("g").groupBy("g").paginate(1, 10);
  expect(grouped.total).toBe(2);
  const all = [1, 2, 3, 4].flatMap((p) => d.items.select().paginate(p, 2).data.map((r: any) => r.n));
  expect(all).toEqual([1, 2, 3, 4, 5, 6, 7]);
  d.close();
});
