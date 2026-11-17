import { expect, test } from "bun:test";
import { Database, z } from "../src";

const schema = {
  files: z.object({ name: z.string(), data: z.custom<Uint8Array>((v) => v instanceof Uint8Array && !Buffer.isBuffer(v)) }),
  flags: z.object({ kind: z.literal(2.5), on: z.literal(true), n: z.literal(7).optional() }),
};

test("rows written the 4.0.4 way read back with their types", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  // 4.0.4 stored literals in TEXT columns as text and Uint8Array as JSON.
  db.raw(`INSERT INTO flags (kind, "on", n) VALUES ('2.5', '1', '7')`);
  db.raw(`INSERT INTO files (name, data) VALUES ('a', '{"0":1,"1":2,"2":255}')`);
  expect(db.flags.select().all()[0]).toMatchObject({ kind: 2.5, on: true, n: 7 });
  const file = db.files.select().all()[0]!;
  expect(file.data).toBeInstanceOf(Uint8Array);
  expect(Array.from(file.data)).toEqual([1, 2, 255]);
  db.close();
});

test("new writes keep Uint8Array bytes and literal types, with no column type change", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const f = db.files.insert({ name: "b", data: new Uint8Array([9, 8]) });
  expect(Array.from(db.files.get(f.id)!.data)).toEqual([9, 8]);
  const g = db.flags.insert({ kind: 2.5, on: true });
  expect(db.flags.get(g.id)).toMatchObject({ kind: 2.5, on: true });
  const types = db.raw<{ name: string; type: string }>(`PRAGMA table_info("files")`);
  expect(types.find((c) => c.name === "data")!.type).toBe("TEXT");
  db.close();
});
