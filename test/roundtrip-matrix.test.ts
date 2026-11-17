/**
 * Cross-product regression matrix: field type × write path × wrapper.
 * Every test uses its own in-memory SQLite database to avoid order dependence.
 * NOTE: SQLite has no undefined storage value: omitted optional columns read NULL.
 */
import { describe, expect, test } from "bun:test";
import { Database, z } from "../src";

const when = new Date("2024-01-01T00:00:00.000Z");
const later = new Date("2025-05-06T07:08:09.000Z");
const huge = 9007199254740997n;
type Fixture = { name: string; schema: any; value: any; alternate: any; equality?: boolean };
const fixtures: Fixture[] = [
  { name: "string/plain", schema: z.string(), value: "hello", alternate: "world", equality: true },
  { name: "string/numeric", schema: z.string(), value: "123", alternate: "0", equality: true },
  { name: "string/json-looking", schema: z.string(), value: '{"a":1}', alternate: "[]", equality: true },
  { name: "string/iso-looking", schema: z.string(), value: when.toISOString(), alternate: later.toISOString(), equality: true },
  { name: "string/empty", schema: z.string(), value: "", alternate: "x", equality: true },
  { name: "string/unicode", schema: z.string(), value: "漢字 café 🧪", alternate: "🚀 ñ", equality: true },
  { name: "number/int", schema: z.number().int(), value: 42, alternate: -8, equality: true },
  { name: "number/float", schema: z.number(), value: 1.25, alternate: -0.75, equality: true },
  { name: "number/zero", schema: z.number(), value: 0, alternate: 3.5, equality: true },
  { name: "number/large-safe", schema: z.number(), value: Number.MAX_SAFE_INTEGER, alternate: -100, equality: true },
  { name: "boolean", schema: z.boolean(), value: true, alternate: false, equality: true },
  { name: "bigint/beyond-safe", schema: z.bigint(), value: huge, alternate: -huge, equality: true },
  { name: "date", schema: z.date(), value: when, alternate: later, equality: true },
  { name: "enum", schema: z.enum(["draft", "done"]), value: "draft", alternate: "done", equality: true },
  { name: "literal/string", schema: z.literal(["alpha", "beta"]), value: "alpha", alternate: "beta", equality: true },
  { name: "literal/number", schema: z.literal([2.5, -4]), value: 2.5, alternate: -4, equality: true },
  { name: "literal/boolean", schema: z.literal([true, false]), value: true, alternate: false, equality: true },
  { name: "literal/bigint", schema: z.literal([huge, -huge]), value: huge, alternate: -huge, equality: true },
  { name: "object/nested-dates-bigints", schema: z.object({ label: z.string(), nested: z.object({ at: z.date(), large: z.bigint() }) }), value: { label: "a", nested: { at: when, large: huge } }, alternate: { label: "b", nested: { at: later, large: -huge } } },
  { name: "array/primitives", schema: z.array(z.number()), value: [1, 2.5, -3], alternate: [] },
  { name: "array/objects", schema: z.array(z.object({ at: z.date(), large: z.bigint() })), value: [{ at: when, large: huge }], alternate: [{ at: later, large: -huge }] },
  { name: "array/empty", schema: z.array(z.string()), value: [], alternate: ["new"] },
  { name: "record", schema: z.record(z.string(), z.object({ at: z.date(), count: z.bigint() })), value: { a: { at: when, count: huge } }, alternate: { b: { at: later, count: -huge } } },
  { name: "tuple", schema: z.tuple([z.string(), z.date(), z.bigint()]), value: ["x", when, huge], alternate: ["y", later, -huge] },
  { name: "union", schema: z.union([z.object({ at: z.date() }), z.object({ count: z.bigint() })]), value: { at: when }, alternate: { count: huge } },
  { name: "discriminatedUnion", schema: z.discriminatedUnion("kind", [z.object({ kind: z.literal("dated"), at: z.date() }), z.object({ kind: z.literal("large"), count: z.bigint() })]), value: { kind: "dated", at: when }, alternate: { kind: "large", count: huge } },
  { name: "any/object", schema: z.any(), value: { x: 1, list: [2] }, alternate: [1, "two"] },
  { name: "any/scalar", schema: z.any(), value: "123", alternate: 12 },
  { name: "unknown/object", schema: z.unknown(), value: ["a", true], alternate: { changed: true } },
  { name: "unknown/scalar", schema: z.unknown(), value: false, alternate: '{"x":1}' },
  { name: "blob/Buffer", schema: z.custom<Buffer>(v => Buffer.isBuffer(v)), value: Buffer.from([0, 127, 255]), alternate: Buffer.from([42, 0]) },
  { name: "blob/Uint8Array", schema: z.custom<Uint8Array>(v => v instanceof Uint8Array && !Buffer.isBuffer(v)), value: new Uint8Array([0, 128, 255]), alternate: new Uint8Array([3, 4]) },
];
const wrappers = [
  { name: "plain", wrap: (s: any, _v: any) => s },
  { name: "optional", wrap: (s: any, _v: any) => s.optional() },
  { name: "nullable", wrap: (s: any, _v: any) => s.nullable() },
  { name: "default", wrap: (s: any, v: any) => s.default(v) },
  { name: "optional.default", wrap: (s: any, v: any) => s.optional().default(v) },
] as const;
const paths = ["insert", "insertMany", "update(id)", "update.where.exec", "upsert/insert", "upsert/update", "entity/assign", "dump/load"] as const;

function assertPayload(table: any, id: number, value: any, marker = "KEEP") {
  const byId = table.get(id);
  expect(byId).not.toBeNull();
  expect(byId.payload).toEqual(value);
  expect(byId.marker).toBe(marker);
  const all = table.select().all();
  const selected = all.find((row: any) => row.id === id);
  expect(selected).toBeDefined();
  expect(selected.payload).toEqual(value);
  expect(selected.marker).toBe(marker);
}

describe("round-trip cross-product: type × path × wrapper", () => {
  for (const fixture of fixtures) for (const wrapper of wrappers) for (const path of paths) {
    test(`${fixture.name} × ${path} × ${wrapper.name}`, () => {
      const db: any = new Database(":memory:", {
        items: z.object({
          key: z.string(),
          marker: z.string().default("KEEP"),
          payload: wrapper.wrap(fixture.schema, fixture.value),
        }),
      }, { reactive: false });
      try {
        const table: any = db.items;
        const insert = (value: any, key: string) => table.insert({ key, marker: "KEEP", payload: value });
        let row: any;
        let expected = fixture.value;
        switch (path) {
          case "insert":
            row = insert(fixture.value, "a");
            break;
          case "insertMany":
            row = table.insertMany([{ key: "a", marker: "KEEP", payload: fixture.value }])[0];
            break;
          case "update(id)":
            row = insert(fixture.alternate, "a");
            table.update(row.id, { payload: fixture.value });
            break;
          case "update.where.exec":
            row = insert(fixture.alternate, "a");
            expect(table.update({ payload: fixture.value }).where({ key: "a" }).exec()).toBe(1);
            break;
          case "upsert/insert":
            row = table.upsert({ key: "a" }, { payload: fixture.value });
            break;
          case "upsert/update":
            row = insert(fixture.alternate, "a");
            table.upsert({ key: "a" }, { payload: fixture.value });
            break;
          case "entity/assign":
            row = insert(fixture.alternate, "a");
            row.payload = fixture.value;
            break;
          case "dump/load": {
            const source = insert(fixture.value, "a");
            const snapshot = db.dump();
            const dest: any = new Database(":memory:", {
              items: z.object({ key: z.string(), marker: z.string().default("KEEP"), payload: wrapper.wrap(fixture.schema, fixture.value) }),
            }, { reactive: false });
            try {
              dest.load(snapshot);
              assertPayload(dest.items, source.id, fixture.value);
            } finally {
              dest.close();
            }
            row = source;
            break;
          }
        }
        assertPayload(table, row.id, expected);
        // WHERE equality is only defined for unambiguous SQL scalars.
        // JSON containers, any/unknown (JSON encoded), blobs and NULL are not
        // supported by the schema-unaware equality builder.
        if (fixture.equality) {
          const found = table.select().where({ payload: fixture.value }).all();
          expect(found.map((r: any) => r.id)).toContain(row.id);
        }
      } finally {
        db.close();
      }
    });
  }
});

describe("omission, explicit null, defaults, and invalid values", () => {
  for (const fixture of fixtures) {
    test(`${fixture.name} × optional/omission reads NULL`, () => {
      const db: any = new Database(":memory:", { items: z.object({ payload: fixture.schema.optional(), marker: z.string().default("original") }) }, { reactive: false });
      try {
        const row = db.items.insert({ marker: "original" });
        expect(db.items.get(row.id).payload).toBeNull();
        db.items.update(row.id, { marker: "changed" });
        expect(db.items.get(row.id).payload).toBeNull();
      } finally { db.close(); }
    });
    test(`${fixture.name} × nullable/explicit-null persists`, () => {
      const db: any = new Database(":memory:", { items: z.object({ payload: fixture.schema.nullable(), marker: z.string().default("original") }) }, { reactive: false });
      try {
        const row = db.items.insert({ payload: null });
        expect(db.items.get(row.id).payload).toBeNull();
        db.items.update(row.id, { marker: "changed" });
        expect(db.items.get(row.id).payload).toBeNull();
      } finally { db.close(); }
    });
    for (const name of ["default", "optional.default"] as const) {
      test(`${fixture.name} × ${name}/omission and partial preservation`, () => {
        const field = name === "default" ? fixture.schema.default(fixture.value) : fixture.schema.optional().default(fixture.value);
        const db: any = new Database(":memory:", { items: z.object({ payload: field, marker: z.string().default("original") }) }, { reactive: false });
        try {
          const row = db.items.insert({});
          assertPayload(db.items, row.id, fixture.value, "original");
          db.items.update(row.id, { marker: "updated" });
          assertPayload(db.items, row.id, fixture.value, "updated");
          db.items.update({ marker: "bulk" }).where({ id: row.id }).exec();
          assertPayload(db.items, row.id, fixture.value, "bulk");
        } finally { db.close(); }
      });
    }
  }
  test("z.number rejects NaN without inserting or changing existing data", () => {
    const db: any = new Database(":memory:", { items: z.object({ payload: z.number(), marker: z.string().default("KEEP") }) }, { reactive: false });
    try {
      expect(() => db.items.insert({ payload: NaN })).toThrow();
      const row = db.items.insert({ payload: 7 });
      expect(() => db.items.update(row.id, { payload: NaN })).toThrow();
      assertPayload(db.items, row.id, 7);
    } finally { db.close(); }
  });
  test("relation .with() preserves nested object dates and bigints", () => {
    const db: any = new Database(":memory:", {
      parents: z.object({ label: z.string() }),
      children: z.object({ parent_id: z.number(), payload: z.object({ at: z.date(), count: z.bigint() }) }),
    }, { reactive: false, relations: { children: { parent_id: "parents" } } });
    try {
      const parent = db.parents.insert({ label: "p" });
      const child = db.children.insert({ parent_id: parent.id, payload: { at: when, count: huge } });
      const loaded = db.parents.select().with("children").get();
      expect(loaded.children[0].id).toBe(child.id);
      expect(loaded.children[0].payload).toEqual({ at: when, count: huge });
    } finally { db.close(); }
  });
  test("4.0.4 TEXT-affinity numeric/boolean literal rows remain readable", () => {
    const db: any = new Database(":memory:", { items: z.object({ n: z.literal(2.5), b: z.literal(true) }) }, { reactive: false });
    try {
      // A pre-upgrade TEXT column is not rebuilt: test schema-based legacy decoding.
      db.exec('DROP TABLE "items"');
      db.exec('CREATE TABLE "items" ("id" INTEGER PRIMARY KEY, "n" TEXT, "b" TEXT)');
      db.exec('INSERT INTO "items" ("n", "b") VALUES (\'2.5\', \'1\')');
      expect(db.items.get(1).n).toBe(2.5);
      expect(db.items.get(1).b).toBe(true);
      const snapshot = db.dump();
      const loaded: any = new Database(":memory:", {
        items: z.object({ n: z.literal(2.5), b: z.literal(true) }),
      }, { reactive: false });
      try {
        loaded.load(snapshot);
        expect(loaded.items.get(1).n).toBe(2.5);
        expect(loaded.items.get(1).b).toBe(true);
      } finally { loaded.close(); }
    } finally { db.close(); }
  });
});
