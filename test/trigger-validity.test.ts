import { expect, test } from "bun:test";
import { Database as RawDatabase } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src";

function withFile(work: (file: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "orm-trigger-"));
  try {
    work(join(dir, "db.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const before = { entries: z.object({ name: z.string(), obsolete: z.string() }) };
const after = { entries: z.object({ name: z.string() }) };
const opts = { reactive: false };

function seed(file: string) {
  const db = new Database(file, before, opts);
  db.entries.insert({ name: "original", obsolete: "kept" });
  return db;
}

function assertRolledBack(file: string, trigger: string) {
  const raw = new RawDatabase(file);
  try {
    expect(raw.query("SELECT * FROM entries").all()).toEqual([
      { id: 1, name: "original", obsolete: "kept" },
    ]);
    expect(raw.query("SELECT name FROM sqlite_master WHERE name = 'entries_v1'").all())
      .toEqual([]);
    expect(raw.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger))
      .toEqual({ name: trigger });
  } finally {
    raw.close();
  }
}

test("rebuild rejects an invalid INSERT trigger on an unrelated table and rolls back", () =>
  withFile((file) => {
    const db = seed(file);
    db.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)");
    db.exec("CREATE TRIGGER audit_ok AFTER INSERT ON audit BEGIN SELECT NEW.id; END");
    db.exec(`CREATE TRIGGER audit_obsolete AFTER INSERT ON audit
      BEGIN UPDATE entries SET obsolete = NEW.note WHERE id = NEW.id; END`);
    db.close();

    expect(() => new Database(file, after, opts))
      .toThrow(/audit_obsolete.*no such column: obsolete/i);
    assertRolledBack(file, "audit_obsolete");
    const raw = new RawDatabase(file);
    try {
      expect(raw.query("SELECT * FROM audit").all()).toEqual([]);
    } finally { raw.close(); }
  }));

test("rebuild rejects an invalid INSTEAD OF UPDATE trigger on a queryable view", () =>
  withFile((file) => {
    const db = seed(file);
    db.exec("CREATE VIEW entry_names AS SELECT id, name FROM entries");
    db.exec(`CREATE TRIGGER entry_names_update INSTEAD OF UPDATE ON entry_names
      BEGIN UPDATE entries SET obsolete = NEW.name WHERE id = OLD.id; END`);
    db.close();

    expect(() => new Database(file, after, opts))
      .toThrow(/entry_names_update.*no such column: obsolete/i);
    assertRolledBack(file, "entry_names_update");
    const raw = new RawDatabase(file);
    try {
      expect(raw.query("SELECT * FROM entry_names").all()).toEqual([
        { id: 1, name: "original" },
      ]);
    } finally { raw.close(); }
  }));

test("rebuild identifies the offending nested trigger, not its caller", () =>
  withFile((file) => {
    const db = seed(file);
    db.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE queue (id INTEGER PRIMARY KEY)");
    db.exec(`CREATE TRIGGER aa_audit_insert AFTER INSERT ON audit
      BEGIN INSERT INTO queue(id) VALUES (NEW.id); END`);
    db.exec(`CREATE TRIGGER zz_queue_broken AFTER INSERT ON queue
      BEGIN UPDATE entries SET obsolete = 'bad'; END`);
    db.close();

    expect(() => new Database(file, after, opts))
      .toThrow(/zz_queue_broken.*no such column: obsolete/i);
    assertRolledBack(file, "zz_queue_broken");
  }));

test("EXPLAIN validates INSERT, UPDATE OF, DELETE and view events without executing writes", () =>
  withFile((file) => {
    const db = seed(file);
    db.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY, note TEXT)");
    db.exec("INSERT INTO audit (id, note) VALUES (5, 'seed')");
    db.exec(`CREATE TRIGGER audit_insert AFTER INSERT ON audit
      BEGIN UPDATE entries SET name = 'insert fired'; END`);
    db.exec(`CREATE TRIGGER audit_update AFTER UPDATE OF note ON audit
      BEGIN UPDATE entries SET name = 'update fired'; END`);
    db.exec(`CREATE TRIGGER audit_rowid AFTER UPDATE OF rowid ON audit
      BEGIN SELECT NEW.id; END`);
    db.exec(`CREATE TRIGGER audit_delete AFTER DELETE ON audit
      BEGIN DELETE FROM entries; END`);
    db.exec("CREATE VIEW entry_names AS SELECT id, name FROM entries");
    db.exec(`CREATE TRIGGER view_insert INSTEAD OF INSERT ON entry_names
      BEGIN INSERT INTO entries (name) VALUES (NEW.name); END`);
    db.close();

    const migrated = new Database(file, after, opts);
    try {
      expect(migrated.raw("SELECT id, name FROM entries")).toEqual([
        { id: 1, name: "original" },
      ]);
      expect(migrated.raw("SELECT * FROM audit")).toEqual([
        { id: 5, note: "seed" },
      ]);
      expect(migrated.raw("SELECT name FROM sqlite_master WHERE type = 'trigger'"))
        .toHaveLength(5);
      migrated.exec("UPDATE audit SET note = 'fired' WHERE id = 5");
      expect(migrated.entries.get(1)?.name).toBe("update fired");
    } finally { migrated.close(); }
  }));

test("UPDATE OF referencing a removed column is rejected even if it cannot fire", () =>
  withFile((file) => {
    const db = seed(file);
    db.exec(`CREATE TRIGGER entries_obsolete AFTER UPDATE OF obsolete ON entries
      BEGIN SELECT NEW.name; END`);
    db.close();

    expect(() => new Database(file, after, opts))
      .toThrow(/entries_obsolete.*no such column: obsolete/i);
    assertRolledBack(file, "entries_obsolete");
  }));

test("rebuild rejects an invalid DELETE trigger on another table", () =>
  withFile((file) => {
    const db = seed(file);
    db.exec("CREATE TABLE audit (id INTEGER PRIMARY KEY)");
    db.exec(`CREATE TRIGGER audit_delete_broken AFTER DELETE ON audit
      BEGIN UPDATE entries SET obsolete = OLD.id; END`);
    db.close();

    expect(() => new Database(file, after, opts))
      .toThrow(/audit_delete_broken.*no such column: obsolete/i);
    assertRolledBack(file, "audit_delete_broken");
  }));
