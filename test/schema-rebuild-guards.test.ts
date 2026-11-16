import { expect, test } from "bun:test";
import { Database as RawDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src";

function withFile(run: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "orm-rebuild-guards-"));
  try { run(join(dir, "test.db")); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

function assertLiveTable(file: string, table: string, rows: unknown[]) {
  const raw = new RawDatabase(file);
  try {
    expect(raw.query(`SELECT * FROM "${table}" ORDER BY id`).all()).toEqual(rows);
    expect(raw.query(
      "SELECT name FROM sqlite_master WHERE name = ?",
    ).all(`${table}_v1`)).toEqual([]);
  } finally { raw.close(); }
}

test("populated TEXT to INTEGER needs an explicit data-conversion migration", () =>
  withFile((file) => {
    const original = new Database(file, { records: z.object({ value: z.string() }) });
    original.records.insert({ value: "not-a-number" });
    original.close();
    expect(() => new Database(file, {
      records: z.object({ value: z.number() }),
    })).toThrow(/records\.value.*explicit data-conversion migration/);
    assertLiveTable(file, "records", [{ id: 1, value: "not-a-number" }]);
    const raw = new RawDatabase(file);
    try {
      expect(raw.query("PRAGMA table_info(records)").all()).toContainEqual(
        expect.objectContaining({ name: "value", type: "TEXT" }),
      );
    } finally { raw.close(); }
  }));

test("dropping a populated column while adding another needs a mapping", () =>
  withFile((file) => {
    const original = new Database(file, { people: z.object({ fullName: z.string() }) });
    original.people.insert({ fullName: "Ada" });
    original.close();
    expect(() => new Database(file, {
      people: z.object({ displayName: z.string().nullable() }),
    })).toThrow(/people\.fullName.*explicit column-mapping migration/);
    assertLiveTable(file, "people", [{ id: 1, fullName: "Ada" }]);
  }));

test("type change on an all-NULL column still permits an additive rebuild", () =>
  withFile((file) => {
    const original = new Database(file, { entries: z.object({ value: z.string().nullable() }) });
    original.entries.insert({ value: null });
    original.close();
    const next = new Database(file, {
      entries: z.object({ value: z.number().nullable(), label: z.string().default("ok") }),
    });
    try {
      expect(next.entries.get(1)?.value).toBeNull();
      expect(next.entries.get(1)?.label).toBe("ok");
    } finally { next.close(); }
  }));

for (const spec of [
  { label: "ON DELETE CASCADE", target: "parents", onDelete: "CASCADE", onUpdate: "NO ACTION" },
  { label: "ON UPDATE CASCADE", target: "parents", onDelete: "SET NULL", onUpdate: "CASCADE" },
  { label: "different FK target", target: "others", onDelete: "SET NULL", onUpdate: "NO ACTION" },
]) {
  test(`legacy ${spec.label} is not silently replaced`, () =>
    withFile((file) => {
      const raw = new RawDatabase(file);
      raw.run('CREATE TABLE "parents" (id INTEGER PRIMARY KEY AUTOINCREMENT)');
      raw.run('CREATE TABLE "others" (id INTEGER PRIMARY KEY AUTOINCREMENT)');
      raw.run(`CREATE TABLE "children" (id INTEGER PRIMARY KEY AUTOINCREMENT,
        "parent_id" INTEGER, FOREIGN KEY ("parent_id") REFERENCES "${spec.target}"(id)
        ON DELETE ${spec.onDelete} ON UPDATE ${spec.onUpdate})`);
      raw.run("INSERT INTO parents DEFAULT VALUES");
      raw.run("INSERT INTO others DEFAULT VALUES");
      raw.run("INSERT INTO children (parent_id) VALUES (1)");
      const fkBefore = raw.query("PRAGMA foreign_key_list(children)").all();
      raw.close();
      expect(() => new Database(file, {
        parents: z.object({}),
        children: z.object({ parent_id: z.number().nullable(), note: z.string().default("new") }),
      }, { relations: { children: { parent_id: "parents" } } })).toThrow(
        /outgoing foreign keys.*explicit foreign-key migration/,
      );
      assertLiveTable(file, "children", [{ id: 1, parent_id: 1 }]);
      const check = new RawDatabase(file);
      try {
        expect(check.query("PRAGMA foreign_key_list(children)").all()).toEqual(fkBefore);
        expect(check.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally { check.close(); }
    }));
}

for (const spec of [
  { label: "CHECK", ddl: "code TEXT CHECK(length(code) > 1)", value: "ok" },
  { label: "NOT NULL", ddl: "code TEXT NOT NULL", value: "ok" },
  { label: "ON CONFLICT", ddl: "code TEXT UNIQUE ON CONFLICT REPLACE", value: "ok" },
  { label: "table CHECK", ddl: "code TEXT, CHECK(length(code) > 1)", value: "ok" },
]) {
  test(`legacy ${spec.label} cannot disappear during rebuild`, () =>
    withFile((file) => {
      const raw = new RawDatabase(file);
      raw.run(`CREATE TABLE docs (id INTEGER PRIMARY KEY AUTOINCREMENT, ${spec.ddl})`);
      raw.query("INSERT INTO docs (code) VALUES (?)").run(spec.value);
      const ddlBefore = (raw.query(
        "SELECT sql FROM sqlite_master WHERE name = 'docs'",
      ).get() as { sql: string }).sql;
      raw.close();
      expect(() => new Database(file, {
        docs: z.object({ code: z.string(), extra: z.string().default("new") }),
      })).toThrow(new RegExp(`legacy ${spec.label.includes("CHECK") ? "CHECK" : spec.label}.*explicit constraint-preserving migration`));
      assertLiveTable(file, "docs", [{ id: 1, code: spec.value }]);
      const check = new RawDatabase(file);
      try {
        expect((check.query("SELECT sql FROM sqlite_master WHERE name = 'docs'").get() as {
          sql: string;
        }).sql).toBe(ddlBefore);
      } finally { check.close(); }
    }));
}

test("quoted identifiers containing constraint keywords are not mistaken for clauses", () =>
  withFile((file) => {
    const raw = new RawDatabase(file);
    raw.run('CREATE TABLE keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, "CHECK" TEXT, "ON CONFLICT" TEXT, "NOT NULL" TEXT)');
    raw.run('INSERT INTO keywords ("CHECK", "ON CONFLICT", "NOT NULL") VALUES (\'yes\', \'no\', \'maybe\')');
    raw.close();
    const db = new Database(file, { keywords: z.object({
      CHECK: z.string(), "ON CONFLICT": z.string(), "NOT NULL": z.string(), extra: z.string().default("new"),
    }) });
    try {
      expect(db.keywords.get(1)?.extra).toBe("new");
      expect(db.keywords.get(1)?.CHECK).toBe("yes");
    } finally { db.close(); }
  }));
