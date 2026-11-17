import { afterAll, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src";

const dir = mkdtempSync(join(tmpdir(), "orm-indexes-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const path = (key: string) => join(dir, `${key}.sqlite`);
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const indexes = (db: any, table: string) =>
  db.raw(`PRAGMA index_list(${quote(table)})`).map((r: any) => r.name) as string[];
const columns = (db: any, index: string) =>
  db.raw(`PRAGMA index_info(${quote(index)})`).map((r: any) => r.name) as string[];

test("composite indexes preserve order and enforce composite uniqueness", () => {
  const db = new Database(path("composite"), {
    pairs: z.object({ region: z.string(), code: z.string() }),
  }, { indexes: { pairs: [["region", "code"]] }, unique: { pairs: [["region", "code"]] }, reactive: false });
  try {
    expect(indexes(db, "pairs").map((n) => columns(db, n))).toEqual([
      ["region", "code"], ["region", "code"],
    ]);
    db.pairs.insert({ region: "x", code: "a" });
    db.pairs.insert({ region: "y", code: "a" });
    expect(() => db.pairs.insert({ region: "x", code: "a" })).toThrow();
  } finally { db.close(); }
});

test("reopening reconciles changed index declarations", () => {
  const schema = { records: z.object({ a: z.string(), b: z.string() }) };
  const first = new Database(path("changed"), schema, {
    indexes: { records: [["a", "b"]] }, unique: { records: [["a", "b"]] }, reactive: false,
  });
  first.close();
  const db = new Database(path("changed"), schema, {
    indexes: { records: [["b", "a"]] }, unique: { records: [["b"]] }, reactive: false,
  });
  try {
    expect(indexes(db, "records").map((n) => columns(db, n)).sort()).toEqual([["b"], ["b", "a"]].sort());
  } finally { db.close(); }
});

test("removed indexed column does not block rebuild", () => {
  const first = new Database(path("removed"), { docs: z.object({ old: z.string(), keep: z.string() }) },
    { indexes: { docs: ["old"] }, reactive: false });
  first.docs.insert({ old: "past", keep: "current" });
  first.close();
  const db = new Database(path("removed"), { docs: z.object({ keep: z.string() }) }, { reactive: false });
  try {
    expect(indexes(db, "docs")).toEqual([]);
    expect(db.docs.count()).toBe(1);
    expect(db.raw<{ name: string }>(`PRAGMA table_info("docs")`).map((r) => r.name)).not.toContain("old");
  } finally { db.close(); }
});

test("quote-bearing column names are safely quoted by index DDL", () => {
  const table = "items";
  const seed = new Sqlite(path("quotes"));
  seed.exec('CREATE TABLE "items" (id INTEGER PRIMARY KEY AUTOINCREMENT, "a""b" TEXT, "group" TEXT)');
  seed.close();
  const db = new Database(path("quotes"), { [table]: z.object({ 'a"b': z.string(), group: z.string() }) },
    { indexes: { [table]: [["a\"b", "group"]] }, unique: { [table]: [["group", 'a"b']] }, reactive: false });
  try {
    expect(indexes(db, table).map((n) => columns(db, n)).sort()).toEqual([
      ['a"b', "group"], ["group", 'a"b'],
    ].sort());
  } finally { db.close(); }
});
