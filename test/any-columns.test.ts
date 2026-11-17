import { expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database, z } from "../src";

const schema = {
  tracks: z.object({
    name: z.string(),
    tone: z.any(),
    meta: z.unknown().optional(),
  }),
};

test("z.any() and z.unknown() values read back with their type", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const values = [{ hz: 432, wave: "sine" }, [1, "two"], 7, 0, true, false, "plain", "123", "{not json"];
  for (const tone of values) {
    const row = db.tracks.insert({ name: "t", tone, meta: tone });
    const back = db.tracks.get(row.id)!;
    expect(back.tone).toEqual(tone);
    expect(back.meta).toEqual(tone);
  }
  db.close();
});

test("updates and upserts keep z.any() types", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const row = db.tracks.insert({ name: "t", tone: 1 });
  db.tracks.update(row.id, { tone: { hz: 528 } });
  expect(db.tracks.get(row.id)!.tone).toEqual({ hz: 528 });
  db.tracks.update(row.id, { tone: 3.5 });
  expect(db.tracks.get(row.id)!.tone).toBe(3.5);
  db.close();
});

test("null stays null, absent optional stays absent", () => {
  const db = new Database(":memory:", schema, { reactive: false });
  const row = db.tracks.insert({ name: "t", tone: null });
  const back = db.tracks.get(row.id)!;
  expect(back.tone).toBeNull();
  expect(back.meta ?? null).toBeNull();
  db.close();
});

test("rows written by older versions still read", () => {
  const dir = mkdtempSync(join(tmpdir(), "orm-any-"));
  try {
    const file = join(dir, "old.sqlite");
    new Database(file, schema, { reactive: false }).close();
    const raw = new Sqlite(file);
    raw.run(`INSERT INTO tracks (name, tone) VALUES ('a', '{"hz":432}'), ('b', 'hello world')`);
    raw.close();
    const db = new Database(file, schema, { reactive: false });
    const rows = db.tracks.select().all();
    expect(rows.find((r) => r.name === "a")!.tone).toEqual({ hz: 432 });
    expect(rows.find((r) => r.name === "b")!.tone).toBe("hello world");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
