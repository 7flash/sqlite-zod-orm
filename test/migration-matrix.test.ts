/**
 * Schema evolution matrix: change × existing table shape × data state.
 * Tests use real on-disk SQLite files and compare raw SQLite values, not only
 * Zod projections (which can hide affinity coercion or a dropped column).
 *
 * Successful destructive rebuilds intentionally retain the vN backup tables,
 * as documented in UPGRADING.md. Failed migrations must never create one.
 */
import { expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src";

type Shape = "plain" | "indexed" | "outgoing-fk" | "incoming-fk" | "soft-deleted" | "trigger-view" | "legacy";
type Change =
  | "add optional" | "add default" | "add required" | "remove empty"
  | "remove populated" | "rename declared" | "rename undeclared"
  | "string → number" | "number → string" | "boolean → number"
  | "object → string" | "any → object" | "optional → required"
  | "required → optional" | "add default wrapper" | "remove default wrapper"
  | "add unique" | "remove unique" | "rename unique"
  | "add index" | "remove index" | "add relation" | "remove relation"
  | "toggle softDeletes" | "add table" | "remove table"
  | "rename + add" | "reopen A after B"
  | "rename + incompatible type" | "rename into existing field";

/** Windows keeps a just-closed SQLite file locked for a moment; a leftover temp folder is harmless. */
function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

const shapes: Shape[] = [
  "plain", "indexed", "outgoing-fk", "incoming-fk", "soft-deleted",
  "trigger-view", "legacy",
];
const changes: Change[] = [
  "add optional", "add default", "add required", "remove empty",
  "remove populated", "rename declared", "rename undeclared",
  "string → number", "number → string", "boolean → number",
  "object → string", "any → object", "optional → required",
  "required → optional", "add default wrapper", "remove default wrapper",
  "add unique", "remove unique", "rename unique", "add index",
  "remove index", "add relation", "remove relation", "toggle softDeletes",
  "add table", "remove table", "rename + add", "reopen A after B",
  "rename + incompatible type", "rename into existing field",
];
const isRelation = (shape: Shape) => shape === "outgoing-fk" || shape === "incoming-fk";
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const optionsBase = { reactive: false, wal: false };

const payloadType = (change: Change) =>
  change === "number → string" ? z.number() :
  change === "boolean → number" ? z.boolean() :
  change === "object → string" ? z.object({ n: z.number() }) :
  z.string();

function schemaFor(shape: Shape, change: Change, stage: "A" | "B") {
  const fields: Record<string, any> = {
    key: z.string(),
    payload: payloadType(change),
    empty: z.string().nullable().optional(),
    meta: z.any(),
    big: z.bigint(),
    amount: z.number(),
    bytes: z.custom<Uint8Array>((v) => v instanceof Uint8Array),
    flag: z.boolean(),
  };
  if (isRelation(shape) || change === "add relation" || change === "remove relation")
    fields.parent_id = z.number().nullable().optional();
  if (change === "rename into existing field")
    fields.newPayload = z.string().nullable().optional();
  if (stage === "B") {
    switch (change) {
      case "add optional": fields.extra = z.string().optional(); break;
      case "add default": fields.extra = z.string().default("default '漢'"); break;
      case "add required": fields.extra = z.string(); break;
      case "remove empty": delete fields.empty; break;
      case "remove populated": delete fields.payload; break;
      case "rename declared":
      case "rename undeclared":
      case "rename + incompatible type":
      case "rename + add":
      case "rename into existing field":
        delete fields.payload;
        fields.newPayload = change === "rename + incompatible type" ? z.number() : payloadType(change);
        if (change === "rename + add") fields.extra = z.number().default(11);
        break;
      case "string → number": fields.payload = z.number(); break;
      case "number → string": fields.payload = z.string(); break;
      case "boolean → number": fields.payload = z.number(); break;
      case "object → string": fields.payload = z.string(); break;
      case "any → object": fields.meta = z.object({ x: z.number(), tag: z.string() }); break;
      case "optional → required": fields.empty = z.string(); break;
      case "required → optional": fields.key = z.string().optional(); break;
      case "add default wrapper": fields.key = z.string().default("fallback"); break;
      case "remove default wrapper": fields.key = z.string(); break;
      case "reopen A after B": fields.extra = z.string().optional(); break;
    }
  }
  if (stage === "A" && change === "remove default wrapper")
    fields.key = z.string().default("fallback");
  return z.object(fields);
}

function makeConfig(shape: Shape, change: Change, stage: "A" | "B", populated: boolean) {
  const schemas: Record<string, any> = { items: schemaFor(shape, change, stage) };
  const options: Record<string, any> = { ...optionsBase };
  if (isRelation(shape) || change === "add relation" || change === "remove relation") {
    schemas.parents = z.object({ label: z.string() });
  }
  if (shape === "incoming-fk") {
    schemas.children = z.object({ item_id: z.number().nullable(), title: z.string() });
    options.relations = { children: { item_id: "items" } };
  }
  if (shape === "outgoing-fk") options.relations = { items: { parent_id: "parents" } };
  if (change === "add relation" && stage === "B")
    options.relations = { ...(options.relations ?? {}), items: { parent_id: "parents" } };
  if (change === "remove relation" && stage === "A")
    options.relations = { ...(options.relations ?? {}), items: { parent_id: "parents" } };
  if (change === "remove relation" && stage === "B" && options.relations) {
    delete options.relations.items;
    if (Object.keys(options.relations).length === 0) delete options.relations;
  }
  // Removing a table means removing the relations that point at it too.
  if (change === "remove table" && stage === "B" && options.relations?.children) {
    delete options.relations.children;
    if (Object.keys(options.relations).length === 0) delete options.relations;
  }
  if (shape === "soft-deleted") options.softDeletes = stage === "A" || change !== "toggle softDeletes";
  else if (change === "toggle softDeletes" && stage === "B") options.softDeletes = true;
  if (shape === "indexed") {
    options.indexes = { items: ["key"] };
    options.unique = { items: [["key"]] };
  }
  if (stage === "B") {
    switch (change) {
      case "add index": options.indexes = { ...(options.indexes ?? {}), items: ["payload"] }; break;
      case "remove index": options.indexes = { items: [] }; break;
      case "add unique": options.unique = { items: [["payload"]] }; break;
      case "remove unique": options.unique = { items: [] }; break;
      case "rename unique": options.unique = { items: [["payload"]] }; break;
      case "add table": schemas.newTable = z.object({ note: z.string() }); break;
      case "remove table": delete schemas.children; break;
    }
    if (["rename declared", "rename + add", "rename + incompatible type",
         "rename into existing field"].includes(change))
      options.renames = { items: { payload: "newPayload" } };
  } else if (change === "remove unique" || change === "rename unique") {
    options.unique = { items: [["key"]] };
  } else if (change === "remove index") {
    options.indexes = { items: ["payload"] };
  } else if (change === "remove table") {
    schemas.oldTable = z.object({ note: z.string() });
  }
  return { schemas, options };
}

function fixtureRows(change: Change, populated: boolean) {
  if (!populated) return [];
  return Array.from({ length: 100 }, (_, i) => ({
    key: `key-${String(i).padStart(3, "0")}-漢字`,
    payload: change === "number → string" ? i + 0.5 :
      change === "boolean → number" ? i % 2 :
      change === "object → string" ? JSON.stringify({ n: i }) :
      i === 0 ? "000123" : i === 1 ? "☃ café 👩🏽‍💻" : `text-${i}`,
    empty: null,
    meta: JSON.stringify({ x: i, tag: i % 2 ? "unicode-漢" : "zero" }),
    big: (9007199254740993n + BigInt(i)).toString(),
    amount: Number.MAX_SAFE_INTEGER - i,
    bytes: new Uint8Array([0, 255, i % 256]),
    flag: i % 2,
    parent_id: 1,
    newPayload: change === "rename into existing field" ? `target-${i}` : null,
  }));
}

function snapshot(file: string) {
  const raw = new SQLite(file);
  try {
    const schema = raw.query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all();
    const tables = raw.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[];
    const rows = Object.fromEntries(tables.map(({ name }) =>
      [name, raw.query(`SELECT * FROM ${quote(name)} ORDER BY id`).all()]));
    return { schema, rows };
  } finally { raw.close(); }
}
function backupNames(file: string) {
  const db = new SQLite(file);
  try {
    return (db.query("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'items_v[0-9]*'").all() as { name: string }[])
      .map((r) => r.name);
  } finally { db.close(); }
}
function checkIntegrity(file: string) {
  const raw = new SQLite(file);
  try {
    expect(raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(raw.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally { raw.close(); }
}
function indexNames(file: string) {
  const raw = new SQLite(file);
  try {
    return (raw.query("PRAGMA index_list(items)").all() as { name: string }[]).map((r) => r.name);
  } finally { raw.close(); }
}

function rejection(change: Change, shape: Shape, populated: boolean): RegExp | null {
  if (change === "add required" && populated) return /Cannot populate required column/;
  if (change === "rename undeclared" && populated) return /Cannot automatically drop populated column/;
  if (change === "rename + incompatible type" && populated) return /Cannot automatically change type of populated column/;
  if (change === "rename into existing field" && populated) return /Cannot automatically rename populated column/;
  if ((change === "string → number" || change === "number → string") && populated)
    return /Cannot automatically change type of populated column/;
  if ((change === "add relation" || change === "remove relation") &&
      !(shape === "outgoing-fk" && change === "add relation"))
    return /outgoing foreign keys.*explicit foreign-key migration/;
  if (change === "toggle softDeletes" && shape === "soft-deleted" && populated)
    return /Cannot automatically drop populated column "items.deletedAt"/;
  return null;
}

for (const change of changes) for (const shape of shapes) for (const populated of [false, true]) {
  test(`${change} × ${shape} × ${populated ? "100 edge rows" : "empty"}`, () => {
    // Not applicable: stage A would add a foreign key to a pre-4.x table,
    // which 4.0 refuses by design (UPGRADING section 5), so stage B never runs.
    if (shape === "legacy" && change === "remove relation") return;
    const dir = mkdtempSync(join(tmpdir(), "szo-evolution-"));
    const file = join(dir, "matrix.sqlite");
    try {
      const a = makeConfig(shape, change, "A", populated);
      if (shape === "legacy") {
        // Pre-4.x tables used unquoted definitions and literal TEXT JSON values.
        const older = new SQLite(file);
        const fields = Object.keys((a.schemas.items as any).shape);
        const ddl = fields.map((name) =>
          `${quote(name)} ${name === "bytes" ? "BLOB" : name === "flag" || name === "amount" || name === "parent_id" ? "INTEGER" : "TEXT"}`);
        older.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, ${ddl.join(", ")})`);
        older.close();
      }
      const first = new Database(file, a.schemas, a.options);
      first.close();
      const raw = new SQLite(file);
      try {
        if (shape === "trigger-view") {
          raw.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)");
          raw.exec("CREATE VIEW item_keys AS SELECT id, key FROM items");
          raw.exec("CREATE TRIGGER item_audit AFTER UPDATE ON items BEGIN INSERT INTO audit(note) VALUES (NEW.key); END");
        }
        if (populated) {
          const rows = fixtureRows(change, populated);
          raw.exec("BEGIN IMMEDIATE");
          try {
            if (a.schemas.parents) raw.exec("INSERT INTO parents(label) VALUES ('parent')");
            const columns = (raw.query("PRAGMA table_info(items)").all() as { name: string }[]).map((r) => r.name);
            const insertColumns = ["key", "payload", "empty", "meta", "big", "amount", "bytes", "flag", "parent_id", "newPayload"]
              .filter((key) => columns.includes(key));
            const q = raw.prepare(`INSERT INTO items (${insertColumns.map(quote).join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})`);
            for (const row of rows) q.run(...insertColumns.map((column) => (row as any)[column]));
            if (a.schemas.children) raw.exec("INSERT INTO children(item_id,title) VALUES (1,'child')");
            if (a.schemas.oldTable) raw.exec("INSERT INTO oldTable(note) VALUES ('do not delete')");
            if (shape === "soft-deleted") raw.exec("UPDATE items SET deletedAt='2026-01-01T00:00:00.000Z' WHERE id IN (1,2)");
            raw.exec("COMMIT");
          } catch (e) { raw.exec("ROLLBACK"); throw e; }
        }
      } finally { raw.close(); }

      const before = snapshot(file);
      const beforeBytes = readFileSync(file);
      const existingBackups = backupNames(file);
      const expectedError = rejection(change, shape, populated);
      const b = makeConfig(shape, change, "B", populated);
      let migrated: any;
      let error: unknown;
      try { migrated = new Database(file, b.schemas, b.options); }
      catch (e) { error = e; }
      finally { migrated?.close(); }

      if (expectedError) {
        expect(String(error)).toMatch(expectedError);
        expect(snapshot(file)).toEqual(before);
        expect(readFileSync(file)).toEqual(beforeBytes);
        expect(backupNames(file)).toEqual(existingBackups);
      } else {
        if (error) throw error;
        if (change === "reopen A after B") {
          const back = new Database(file, a.schemas, a.options);
          back.close();
        }
        const after = snapshot(file);
        const oldRows = before.rows.items as Record<string, any>[];
        const newRows = after.rows.items as Record<string, any>[];
        expect(newRows.length).toBe(oldRows.length);
        const remapped = ["rename declared", "rename + add", "rename into existing field", "rename + incompatible type"];
        for (let i = 0; i < oldRows.length; i++) {
          const old = oldRows[i]!, next = newRows[i]!;
          expect(next.id).toBe(old.id);
          for (const [key, value] of Object.entries(old)) {
            if (key in next) {
              // Semantic type conversions on unchanged SQL affinity are
              // necessarily outside the auto migration's knowledge.
              expect(next[key]).toEqual(value);
            } else if (key === "payload" && remapped.includes(change)) {
              expect(next.newPayload).toEqual(value);
            } else if (key === "deletedAt" && change === "toggle softDeletes") {
              expect(value).toBeNull();
            } else if (key === "empty" || key === "payload") {
              // Existing 4.0 policy permits dropping a field without adding
              // another; its last values survive in the versioned backup.
              const backups = backupNames(file);
              expect(backups.length).toBeGreaterThan(0);
              const check = new SQLite(file);
              try {
                const archived = check.query(`SELECT * FROM ${quote(backups[backups.length - 1]!)} ORDER BY id`).all() as Record<string, any>[];
                expect(archived[i]![key]).toEqual(value);
              } finally { check.close(); }
            } else {
              throw new Error(`Lost column ${key} in ${change} / ${shape}`);
            }
          }
        }
        if (change === "add index" || change === "rename unique" || change === "add unique")
          expect(indexNames(file)).toContain(`${change === "add index" ? "idx" : "uq"}_items_payload`);
        if (change === "remove index") expect(indexNames(file)).not.toContain("idx_items_payload");
        if (change === "remove unique") expect(indexNames(file)).not.toContain("uq_items_key");
        if (change === "add table") expect(after.rows.newTable).toEqual([]);
        if (change === "remove table") expect(after.rows.oldTable).toEqual(before.rows.oldTable);
        // Verify the public read path as well as byte-for-byte SQLite values.
        const readConfig = change === "reopen A after B" ? a : b;
        const readback: any = new Database(file, readConfig.schemas, readConfig.options);
        try {
          const selection = readback.items.select();
          const typed = (readConfig.options.softDeletes ? selection.withTrashed() : selection)
            .orderBy("id", "asc").all();
          expect(typed).toHaveLength(oldRows.length);
          for (let i = 0; i < typed.length; i++) {
            const row = typed[i]!;
            expect(row.id).toBe(oldRows[i]!.id);
            expect(row.key).toBe(oldRows[i]!.key);
            expect(row.big).toBe(BigInt(oldRows[i]!.big));
            expect(row.amount).toBe(oldRows[i]!.amount);
            expect(row.flag).toBe(Boolean(oldRows[i]!.flag));
            expect(row.bytes).toEqual(new Uint8Array(oldRows[i]!.bytes));
            expect(row.meta).toEqual(JSON.parse(oldRows[i]!.meta));
          }
        } finally { readback.close(); }
        if (shape === "trigger-view") {
          const check = new SQLite(file);
          try { expect(check.query("SELECT * FROM item_keys").all()).toHaveLength(oldRows.length); }
          finally { check.close(); }
        }
        checkIntegrity(file);
      }
    } finally { cleanup(dir); }
  });
}

/** Aborting during rebuild must unwind DROP/CREATE/COPY and restore triggers. */
test("failing dependent trigger rolls back a partially executed rebuild byte-for-byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "szo-rebuild-crash-"));
  const file = join(dir, "crash.sqlite");
  try {
    const a = new Database(file, { items: z.object({ key: z.string(), obsolete: z.string() }) }, optionsBase);
    a.items.insert({ key: "漢", obsolete: "must survive" });
    a.close();
    const raw = new SQLite(file);
    raw.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)");
    raw.exec("CREATE TRIGGER crash_probe AFTER INSERT ON audit BEGIN UPDATE items SET obsolete=NEW.note; END");
    raw.close();
    const state = snapshot(file);
    const bytes = readFileSync(file);
    expect(() => new Database(file, { items: z.object({ key: z.string(), extra: z.string().default("x") }) }, optionsBase))
      .toThrow();
    expect(snapshot(file)).toEqual(state);
    expect(readFileSync(file)).toEqual(bytes);
    expect(backupNames(file)).toEqual([]);
  } finally { cleanup(dir); }
});


test("adding a UNIQUE index to duplicate existing values fails atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "szo-unique-failure-"));
  const file = join(dir, "unique.sqlite");
  try {
    const schema = { items: z.object({ key: z.string(), bucket: z.string() }) };
    const original = new Database(file, schema, optionsBase);
    original.items.insert({ key: "one", bucket: "same" });
    original.items.insert({ key: "two", bucket: "same" });
    original.close();
    const before = snapshot(file);
    const bytes = readFileSync(file);
    expect(() => new Database(file, schema, {
      ...optionsBase, unique: { items: [["bucket"]] },
    })).toThrow();
    expect(snapshot(file)).toEqual(before);
    expect(readFileSync(file)).toEqual(bytes);
    expect(backupNames(file)).toEqual([]);
  } finally { cleanup(dir); }
});
