import { expect, test } from "bun:test";
import { z } from "zod";
import { Database } from "../src/database";

const schemas = {
  parents: z.object({
    label: z.string(), enabled: z.boolean(),
    meta: z.object({ tags: z.array(z.string()) }),
    at: z.date().nullable(), amount: z.bigint().nullable(),
  }),
  children: z.object({ label: z.string() }),
};

function make() {
  const db = new Database(":memory:", schemas);
  db.exec('ALTER TABLE children ADD COLUMN parentId INTEGER REFERENCES parents(id)');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}
function insert(db: ReturnType<typeof make>) {
  db.exec(`INSERT INTO parents (id,label,enabled,meta,at,amount)
    VALUES (40,'p',1,'{"tags":["a"]}','2024-01-02T03:04:05.000Z',9007199254740993)`);
  db.exec("INSERT INTO children (id,label,parentId) VALUES (41,'c',40)");
}

test("JSON-safe 64-bit dump, exact IDs and child-first replacement", () => {
  const src = make(); insert(src);
  const expected = src.dump();
  // bigint columns are stored as TEXT, so the exact value survives as a string.
  expect(expected.parents![0].amount).toBe("9007199254740993");
  const dst = make();
  dst.exec(`INSERT INTO parents (id,label,enabled,meta,at,amount)
    VALUES (99,'old',0,'{"tags":[]}',NULL,NULL)`);
  dst.load(JSON.parse(JSON.stringify({ children: expected.children, parents: expected.parents })));
  expect(dst.dump()).toEqual(expected);
  expect(() => dst.load(expected, { append: true })).toThrow();
  expect(dst.dump()).toEqual(expected);
});

test("validation and foreign-key failure roll back every change", () => {
  const db = make(); insert(db);
  const prior = db.dump();
  const good = { id: 100, label: "valid", enabled: 1, meta: '{"tags":[]}', at: null, amount: null };
  expect(() => db.load({ parents: [good, { ...good, id: 101, label: 17 }] })).toThrow();
  expect(() => db.load({ parents: [{ ...good, enabled: "wrong" }] })).toThrow();
  expect(() => db.load({ parents: [{ ...good, meta: "not JSON" }] })).toThrow();
  expect(() => db.load({ parents: [{ ...good, at: "not a date" }] })).toThrow();
  expect(() => db.load({ children: [{ id: 102, label: "orphan", parentId: 999 }] })).toThrow();
  expect(db.dump()).toEqual(prior);
});

test("undefined uses a SQLite default while null stays NULL", () => {
  const db = new Database(":memory:", { items: z.object({ label: z.string() }) });
  db.exec("ALTER TABLE items ADD COLUMN extra TEXT DEFAULT 'fallback'");
  db.load({ items: [{ label: "omitted", extra: undefined }, { label: "null", extra: null }] });
  expect(db.dump().items!.map((row) => row.extra)).toEqual(["fallback", null]);
});
