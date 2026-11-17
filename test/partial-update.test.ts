import { expect, test } from "bun:test";
import { Database, z } from "../src";

const schema = {
  t: z.object({
    rid: z.number(),
    a: z.string().default(""),
    s: z.string().default("{}"),
    n: z.number().default(0),
    tags: z.array(z.string()).default([]),
    on: z.boolean().default(false),
  }),
};
const full = { rid: 1, a: "x", s: "KEEP", n: 5, tags: ["k"], on: true };

test("update(id, partial) leaves other defaulted fields alone", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const row = db.t.insert(full);
  db.t.update(row.id, { a: "y" });
  expect(db.t.get(row.id)).toMatchObject({ ...full, a: "y" });
  db.close();
});

test("update(partial).where().exec() leaves other defaulted fields alone", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const row = db.t.insert(full);
  db.t.update({ n: 9 }).where({ rid: 1 }).exec();
  expect(db.t.get(row.id)).toMatchObject({ ...full, n: 9 });
  db.close();
});

test("upsert and entity field writes leave other defaulted fields alone", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const row = db.t.insert(full);
  db.t.upsert({ rid: 1 }, { rid: 1, a: "u" } as any);
  expect(db.t.get(row.id)).toMatchObject({ ...full, a: "u" });
  const entity: any = db.t.get(row.id)!;
  entity.n = 7;
  expect(db.t.get(row.id)).toMatchObject({ ...full, a: "u", n: 7 });
  db.close();
});

test("explicitly passed values are still validated and written", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const row = db.t.insert(full);
  db.t.update(row.id, { s: "{}", on: false });
  expect(db.t.get(row.id)).toMatchObject({ ...full, s: "{}", on: false });
  expect(() => db.t.update(row.id, { n: "bad" } as any)).toThrow();
  db.close();
});
